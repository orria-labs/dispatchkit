import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(rootDir, "dist");
const srcGeneratedDir = join(rootDir, "src", "generated", "runtime");
const distGeneratedDir = join(distDir, "generated", "runtime");

async function collectDtsFiles(dir, output = []) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectDtsFiles(fullPath, output);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".d.ts")) {
			output.push(fullPath);
		}
	}
	return output;
}

function rewriteDeclarationSpecifiers(content) {
	return content
		.replace(/(from\s+["'][^"']+?)(?<!\.d)\.ts(["'])/g, "$1.js$2")
		.replace(/(import\(\s*["'][^"']+?)(?<!\.d)\.ts(["']\s*\))/g, "$1.js$2");
}

async function rewriteDtsImports() {
	const files = await collectDtsFiles(distDir);
	await Promise.all(
		files.map(async (filePath) => {
			const original = await readFile(filePath, "utf8");
			const rewritten = rewriteDeclarationSpecifiers(original);
			if (rewritten !== original) {
				await writeFile(filePath, rewritten);
			}
		}),
	);
}

async function copyGeneratedDeclarations() {
	await mkdir(distGeneratedDir, { recursive: true });
	await Promise.all(
		["bus.d.ts", "runtime.d.ts"].map((fileName) =>
			copyFile(
				join(srcGeneratedDir, fileName),
				join(distGeneratedDir, fileName),
			),
		),
	);
}

await copyGeneratedDeclarations();
await rewriteDtsImports();
