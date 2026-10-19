import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";
import type { Node } from "@babel/types";

import { DispatchkitError } from "./errors.ts";

type DefinitionKind = "infra" | "transport";
type Reference = { source: string; imported: string };
type Binding = Node | Reference;
type Value =
  | { type: "factory"; kind: DefinitionKind }
  | { type: "definition"; kind: DefinitionKind }
  | { type: "namespace"; source: string; filePath: string };
type ModuleInfo = {
  bindings: Map<string, Binding>;
  exports: Map<string, Binding>;
  stars: string[];
};

const ownDir = dirname(fileURLToPath(import.meta.url));
const ownEntries = new Set([
  join(ownDir, "index.ts"),
  join(ownDir, "index.js"),
  join(ownDir, "define.ts"),
  join(ownDir, "define.js"),
]);

/** Follow syntax and module references only; never import application code. */
export function createModuleClassifier(): (filePath: string) => Promise<DefinitionKind> {
  const modules = new Map<string, Promise<ModuleInfo>>();

  async function readModule(filePath: string): Promise<ModuleInfo> {
    let pending = modules.get(filePath);
    if (pending) return pending;
    pending = (async () => {
      const ast = parse(await Bun.file(filePath).text(), {
        sourceType: "module",
        sourceFilename: filePath,
        plugins: ["typescript", "decorators-legacy"],
        attachComment: false,
      });
      const info: ModuleInfo = { bindings: new Map(), exports: new Map(), stars: [] };
      const addDeclaration = (node: Node | null | undefined, exported: boolean) => {
        if (node?.type !== "VariableDeclaration") return;
        for (const declaration of node.declarations) {
          if (declaration.id.type !== "Identifier" || !declaration.init) continue;
          // Mutable values cannot be classified reliably without executing code.
          if (node.kind !== "const") continue;
          info.bindings.set(declaration.id.name, declaration.init);
          if (exported) info.exports.set(declaration.id.name, declaration.id);
        }
      };
      for (const node of ast.program.body) {
        if (node.type === "ImportDeclaration" && node.importKind !== "type") {
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;
            const imported =
              specifier.type === "ImportDefaultSpecifier"
                ? "default"
                : specifier.type === "ImportNamespaceSpecifier"
                  ? "*"
                  : specifier.imported.type === "Identifier"
                    ? specifier.imported.name
                    : specifier.imported.value;
            info.bindings.set(specifier.local.name, { source: node.source.value, imported });
          }
        } else if (node.type === "ExportDefaultDeclaration") {
          info.exports.set("default", node.declaration);
        } else if (node.type === "ExportNamedDeclaration" && node.exportKind !== "type") {
          addDeclaration(node.declaration, true);
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;
            const name =
              specifier.exported.type === "Identifier"
                ? specifier.exported.name
                : specifier.exported.value;
            const local = specifier.local.name;
            info.exports.set(
              name,
              node.source ? { source: node.source.value, imported: local } : specifier.local,
            );
          }
        } else if (node.type === "ExportAllDeclaration" && node.exportKind !== "type") {
          info.stars.push(node.source.value);
        } else {
          addDeclaration(node, false);
        }
      }
      return info;
    })();
    modules.set(filePath, pending);
    return pending;
  }

  function resolveLocal(source: string, from: string): string | undefined {
    if (!source.startsWith(".") && !isAbsolute(source)) return undefined;
    try {
      return Bun.resolveSync(source, dirname(from));
    } catch {
      return undefined;
    }
  }

  async function evaluateReference(
    reference: Reference,
    filePath: string,
    seen: Set<string>,
  ): Promise<Value | undefined> {
    const resolved = resolveLocal(reference.source, filePath);
    const own =
      reference.source === "@orria/dispatchkit" ||
      (resolved !== undefined && ownEntries.has(resolved));
    if (reference.imported === "*") {
      return { type: "namespace", source: reference.source, filePath };
    }
    if (own) {
      const kind =
        reference.imported === "defineInfra"
          ? "infra"
          : reference.imported === "defineTransport"
            ? "transport"
            : undefined;
      return kind ? { type: "factory", kind } : undefined;
    }
    if (!resolved) return undefined;
    return evaluateSymbol(resolved, reference.imported, true, seen);
  }

  async function evaluateSymbol(
    filePath: string,
    name: string,
    exported: boolean,
    seen: Set<string>,
  ): Promise<Value | undefined> {
    const key = JSON.stringify([filePath, name, exported]);
    if (seen.has(key)) return undefined;
    const nextSeen = new Set(seen).add(key);
    const info = await readModule(filePath);
    const value = (exported ? info.exports : info.bindings).get(name);
    if (value) return evaluate(value, filePath, nextSeen);
    if (exported && name !== "default") {
      for (const source of info.stars) {
        const result = await evaluateReference({ source, imported: name }, filePath, nextSeen);
        if (result) return result;
      }
    }
    return undefined;
  }

  async function evaluate(
    node: Binding,
    filePath: string,
    seen: Set<string>,
  ): Promise<Value | undefined> {
    if (!("type" in node)) return evaluateReference(node, filePath, seen);
    switch (node.type) {
      case "Identifier":
        return evaluateSymbol(filePath, node.name, false, seen);
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSNonNullExpression":
      case "ParenthesizedExpression":
        return evaluate(node.expression, filePath, seen);
      case "CallExpression": {
        const factory = await evaluate(node.callee, filePath, seen);
        return factory?.type === "factory" ? { type: "definition", kind: factory.kind } : undefined;
      }
      case "MemberExpression": {
        const namespace = await evaluate(node.object, filePath, seen);
        const name =
          !node.computed && node.property.type === "Identifier"
            ? node.property.name
            : node.computed && node.property.type === "StringLiteral"
              ? node.property.value
              : undefined;
        return namespace?.type === "namespace" && name
          ? evaluateReference(
              { source: namespace.source, imported: name },
              namespace.filePath,
              seen,
            )
          : undefined;
      }
      default:
        return undefined;
    }
  }

  return async (filePath) => {
    const value = await evaluateSymbol(resolve(filePath), "default", true, new Set());
    if (value?.type === "definition") return value.kind;
    throw new DispatchkitError(
      `DISPATCHKIT_DISCOVERY_UNKNOWN_DEFINITION: Cannot statically classify "${filePath}". Export defineInfra(...) or defineTransport(...) directly, through const bindings, or through local imports/re-exports.`,
    );
  };
}
