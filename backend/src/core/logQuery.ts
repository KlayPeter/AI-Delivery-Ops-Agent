export interface NormalizedLogQuery {
    page: number;
    pageSize: number;
    startAt?: string;
    endBefore?: string;
}

export function normalizeLogQuery(
    query: Record<string, unknown>,
    defaultPageSize: number,
    maxPageSize: number = 200,
): NormalizedLogQuery {
    const page = boundedInteger(query.page, 1, 1, 1_000_000);
    const pageSize = boundedInteger(query.pageSize, defaultPageSize, 1, maxPageSize);
    const startDate = String(query.startDate || "").trim();
    const endDate = String(query.endDate || "").trim();
    const startAt = startDate ? shanghaiDayStart(startDate) : undefined;
    const endAt = endDate ? shanghaiDayStart(endDate) : undefined;
    const endBefore = endAt ? new Date(Date.parse(endAt) + 24 * 60 * 60_000).toISOString() : undefined;

    if (startAt && endBefore && startAt >= endBefore) {
        throw new Error("startDate must not be after endDate");
    }
    return { page, pageSize, startAt, endBefore };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    const parsed = typeof value === "number" ? value : Number(String(value || ""));
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function shanghaiDayStart(dateText: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
    if (!match) throw new Error(`Invalid date: ${dateText}`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (
        calendarDate.getUTCFullYear() !== year ||
        calendarDate.getUTCMonth() !== month - 1 ||
        calendarDate.getUTCDate() !== day
    ) {
        throw new Error(`Invalid date: ${dateText}`);
    }
    return new Date(`${dateText}T00:00:00+08:00`).toISOString();
}
