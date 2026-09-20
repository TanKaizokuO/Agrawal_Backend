import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { z } from "zod";
import { isRecord } from "../adapters/guards.js";
import { assertOpenApiCoverage } from "./coverage.js";
import { generateOpenApiDocument } from "./registry.js";

const frozenContractPath = fileURLToPath(new URL("../../openapi/v1.yaml", import.meta.url));

const frozenDocumentSchema = z.custom<OpenAPIObject>(
  (value): value is OpenAPIObject => isRecord(value)
    && typeof value.openapi === "string"
    && isRecord(value.info)
    && typeof value.info.title === "string"
    && typeof value.info.version === "string"
    && isRecord(value.paths),
);

export function readFrozenOpenApiContract(): OpenAPIObject {
  const parsed: unknown = parseYaml(readFileSync(frozenContractPath, "utf8"));
  return frozenDocumentSchema.parse(parsed);
}

/**
 * Build the server document from the frozen client contract and the existing
 * Zod/OpenAPI registry. Resource operations and schemas remain single-sourced
 * in v1.yaml; the registry contributes the server's explicit health paths.
 */
export function generateServerOpenApiDocument(): OpenAPIObject {
  const frozenContract = readFrozenOpenApiContract();
  const registeredDocument = generateOpenApiDocument();
  const frozenComponents = frozenContract.components ?? {};
  const registeredComponents = registeredDocument.components ?? {};
  const document: OpenAPIObject = {
    ...frozenContract,
    paths: {
      ...frozenContract.paths,
      ...registeredDocument.paths,
    },
    components: {
      ...frozenComponents,
      ...registeredComponents,
      schemas: {
        ...frozenComponents.schemas,
        ...registeredComponents.schemas,
      },
      parameters: {
        ...frozenComponents.parameters,
        ...registeredComponents.parameters,
      },
    },
  };
  assertOpenApiCoverage(document, frozenContract);
  return document;
}

export async function writeOpenApi(outputPath: string): Promise<void> {
  const document = generateServerOpenApiDocument();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

export async function main(): Promise<void> {
  const outputPath = fileURLToPath(new URL("../../openapi.json", import.meta.url));
  await writeOpenApi(resolve(outputPath));
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  await main();
}
