import { describe, expect, it } from "vitest";
import {
  generateServerOpenApiDocument,
  readFrozenOpenApiContract,
} from "../src/openapi/generate.js";
import {
  assertOpenApiCoverage,
  runtimeOperations,
} from "../src/openapi/coverage.js";

describe("server OpenAPI coverage", () => {
  it("covers every frozen and mounted operation deterministically", () => {
    const frozen = readFrozenOpenApiContract();
    const first = generateServerOpenApiDocument();
    const second = generateServerOpenApiDocument();

    assertOpenApiCoverage(first, frozen);
    expect(Object.keys(first.paths ?? {})).toHaveLength(83);
    expect(runtimeOperations).toHaveLength(95);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("rejects a missing frozen operation and an undocumented runtime operation", () => {
    const frozen = readFrozenOpenApiContract();
    const document = generateServerOpenApiDocument();
    const missingDocumentOperation = structuredClone(document);
    const authSessionPath = missingDocumentOperation.paths?.["/v1/auth/session"];
    if (authSessionPath === undefined || authSessionPath.post === undefined) {
      throw new Error("The frozen auth session operation is not present");
    }
    delete authSessionPath.post;
    expect(() => {
      assertOpenApiCoverage(missingDocumentOperation, frozen);
    }).toThrow(
      /Frozen\/server OpenAPI method\/path coverage mismatch/u,
    );

    const missingRuntimeOperation = runtimeOperations.slice(0, -1);
    expect(() => {
      assertOpenApiCoverage(document, frozen, missingRuntimeOperation);
    }).toThrow(
      /Runtime\/server OpenAPI method\/path coverage mismatch/u,
    );
  });
});
