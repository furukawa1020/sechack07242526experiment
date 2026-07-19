import { describe, expect, it } from "vitest";

import { formatPresentationPosition, UI_COPY } from "../../../src/shared/copy.js";

describe("participant UI copy", () => {
  it("keeps the approved introduction and scenario disclosure verbatim", () => {
    expect(UI_COPY.intro.title).toBe("同じ身体データを、4つの方法で提示します");
    expect(UI_COPY.intro.body).toContain("どの方法が正しいかを選ぶ課題ではありません。");
    expect(UI_COPY.intro.scenario).toBe(
      "これから表示されるデータの取扱いは、比較のためのシナリオです。\n"
      + "この実験で、実際の身体データをクラウドへ送信・保存することはありません。",
    );
  });

  it("keeps A/B result copy and C/D puffer copy centralized", () => {
    expect(UI_COPY.result).toEqual({
      title: "現在の状態",
      metric: "状態指標",
      score: "72 / 100",
      label: "高ストレス",
      puffer: "状態はフグ型デバイスに\n反映されています",
    });
    expect(UI_COPY.summary.conditionLabels.cloud.label).toBe("クラウド × 状態ラベル");
    expect(UI_COPY.summary.conditionLabels.local.label).toBe("この端末内 × 状態ラベル");
    expect(UI_COPY.summary.conditionLabels.cloud.puffer).toBe("クラウド × フグのふくらみ");
    expect(UI_COPY.summary.conditionLabels.local.puffer).toBe("この端末内 × フグのふくらみ");
  });

  it("formats all four neutral presentation headings", () => {
    expect([1, 2, 3, 4].map((position) =>
      formatPresentationPosition(position as 1 | 2 | 3 | 4),
    )).toEqual(["第1提示 / 4", "第2提示 / 4", "第3提示 / 4", "第4提示 / 4"]);
    expect(UI_COPY.footer.medical).toBe("この表示は医療上の診断ではありません。");
  });
});
