import { describe, expect, test } from "bun:test";
import { normalizeLogQuery } from "@/core/logQuery";

describe("log query normalization", () => {
    test("bounds pagination and falls back for malformed values", () => {
        expect(normalizeLogQuery({ page: "-5", pageSize: "999999" }, 20)).toMatchObject({
            page: 1,
            pageSize: 200,
        });
        expect(normalizeLogQuery({ page: "1abc", pageSize: "NaN" }, 15)).toMatchObject({
            page: 1,
            pageSize: 15,
        });
    });

    test("converts Shanghai calendar days to an exclusive UTC range", () => {
        expect(normalizeLogQuery({
            startDate: "2026-07-27",
            endDate: "2026-07-27",
        }, 20)).toEqual({
            page: 1,
            pageSize: 20,
            startAt: "2026-07-26T16:00:00.000Z",
            endBefore: "2026-07-27T16:00:00.000Z",
        });
    });

    test("rejects invalid or reversed calendar ranges", () => {
        expect(() => normalizeLogQuery({ startDate: "2026-02-30" }, 20)).toThrow("Invalid date");
        expect(() => normalizeLogQuery({ startDate: "2026-07-28", endDate: "2026-07-27" }, 20)).toThrow("startDate");
    });
});
