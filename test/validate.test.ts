import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validate } from "../src/http/validate.js";

describe("validate", () => {
  it("replaces req.query with the parsed query on Express 5", async () => {
    const app = express();
    app.get(
      "/items",
      validate({ query: z.object({ limit: z.coerce.number().int() }) }),
      (req, res) => {
        res.json({ query: req.query });
      },
    );

    const response = await request(app).get("/items?limit=5");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ query: { limit: 5 } });
  });
});
