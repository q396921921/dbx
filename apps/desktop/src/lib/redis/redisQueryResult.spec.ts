import { describe, expect, it } from "vitest";
import { redisCommandResultToQueryResult } from "@/lib/redis/redisQueryResult";

describe("redisCommandResultToQueryResult", () => {
  it("pairs member/score rows for ZREVRANGE ... WITHSCORES instead of one row per array element", () => {
    const flat = ["carol", "300", "bob", "200", "alice", "100"];
    const result = redisCommandResultToQueryResult(flat, 5, "ZREVRANGE issue7229_repro:zset 0 -1 WITHSCORES");
    expect(result.columns).toEqual(["member", "score"]);
    expect(result.rows).toEqual([
      ["carol", "300"],
      ["bob", "200"],
      ["alice", "100"],
    ]);
    expect(result.affected_rows).toBe(3);
  });

  it("pairs member/score rows for ZRANGE ... WITHSCORES (lowercase modifier)", () => {
    const flat = ["alice", "1.5"];
    const result = redisCommandResultToQueryResult(flat, 5, "zrange myset 0 -1 withscores");
    expect(result.columns).toEqual(["member", "score"]);
    expect(result.rows).toEqual([["alice", "1.5"]]);
  });

  it("does not pair a plain ZRANGE result (no WITHSCORES modifier)", () => {
    const flat = ["alice", "bob"];
    const result = redisCommandResultToQueryResult(flat, 5, "ZRANGE myset 0 -1");
    expect(result.columns).toEqual(["(index)", "value"]);
    expect(result.rows).toEqual([
      [1, "alice"],
      [2, "bob"],
    ]);
  });

  it("still pairs field/value rows for HGETALL when given the full raw command text (not just the bare command head)", () => {
    const flat = ["name", "alice", "age", "30"];
    const result = redisCommandResultToQueryResult(flat, 5, "HGETALL myhash");
    expect(result.columns).toEqual(["field", "value"]);
    expect(result.rows).toEqual([
      ["name", "alice"],
      ["age", "30"],
    ]);
  });
});
