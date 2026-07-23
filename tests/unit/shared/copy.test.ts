import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatPresentationPosition,
  formatResponseCheckpointTitle,
  UI_COPY,
} from "../../../src/shared/copy.js";

const normalizeLineEndings = (value: string): string => value.replace(/\r\n?/gu, "\n");

describe("participant UI copy", () => {
  it("keeps the approved introduction and scenario disclosure verbatim", () => {
    expect(UI_COPY.intro.title).toBe("同じ固定模擬データを、4つの方法で提示します");
    expect(UI_COPY.intro.body).toContain("どの方法が正しいかを選ぶ課題ではありません。");
    expect(UI_COPY.intro.scenario).toBe(
      "これから表示される値は、比較のために用意した同じ固定模擬データです。\n"
      + "表示される値は、あなた自身を測定したものではありません。\n"
      + "この実験では、心拍その他の生体データを取得しません。\n\n"
      + "これから表示されるデータの取扱いは、比較のためのシナリオです。\n"
      + "この実験用Webアプリから、固定模擬身体データを外部へ送信・保存することはありません。\n\n"
      + "画面上のフグは表示だけの表現で、USB機器や実機は接続・動作していません。",
    );
    expect(UI_COPY.header.sameData).toBe("同じ固定模擬データを使用しています");
    expect(UI_COPY.processing).toBe("固定模擬データを処理しています…");
    expect(UI_COPY.summary.body).toBe("4つの提示は以上です。\n研究スタッフの案内をお待ちください。");
    expect(JSON.stringify(UI_COPY)).not.toMatch(/Googleフォーム|forms\.gle|QRコード|アンケート/iu);
    expect(UI_COPY.intro.physicalScenario).not.toContain("USB機器や実機は接続・動作していません");
  });

  it("keeps A/B result copy and C/D puffer copy centralized", () => {
    expect(UI_COPY.result).toEqual({
      title: "現在の状態",
      metric: "状態指標",
      score: "72 / 100",
      label: "高ストレス",
      pufferPhysical: "状態はフグ型デバイスに\n反映されています",
      pufferScreen: "状態は画面上のフグの\nふくらみで表されています",
    });
    expect(UI_COPY.summary.conditionLabels.cloud.label).toBe("クラウド × 状態ラベル");
    expect(UI_COPY.summary.conditionLabels.local.label).toBe("この端末内 × 状態ラベル");
    expect(UI_COPY.summary.conditionLabels.cloud.puffer).toBe("クラウド × フグのふくらみ");
    expect(UI_COPY.summary.conditionLabels.local.puffer).toBe("この端末内 × フグのふくらみ");
    expect(UI_COPY.summary.screenPufferLabels.cloud).toBe("クラウド × 画面上のフグのふくらみ");
    expect(UI_COPY.summary.screenPufferLabels.local).toBe("この端末内 × 画面上のフグのふくらみ");
  });

  it("formats all four neutral presentation headings", () => {
    expect([1, 2, 3, 4].map((position) =>
      formatPresentationPosition(position as 1 | 2 | 3 | 4),
    )).toEqual(["第1提示 / 4", "第2提示 / 4", "第3提示 / 4", "第4提示 / 4"]);
    expect([1, 2, 3, 4].map((position) =>
      formatResponseCheckpointTitle(position as 1 | 2 | 3 | 4),
    )).toEqual([
      "第1提示は終了しました",
      "第2提示は終了しました",
      "第3提示は終了しました",
      "第4提示は終了しました",
    ]);
    expect(UI_COPY.response.waiting).toBe("研究スタッフの案内をお待ちください。");
    expect(UI_COPY.footer.medical).toBe("この表示は医療上の診断ではありません。");
  });

  it("keeps the repository and reusable-package copy documents synchronized with formal UI copy", async () => {
    const [document, packagedDocument] = await Promise.all([
      readFile(resolve("docs", "UI_COPY.md"), "utf8"),
      readFile(resolve("SecHack_Experiment_Codex_Package", "docs", "UI_COPY.md"), "utf8"),
    ]);
    const normalizedDocument = normalizeLineEndings(document);
    const normalizedPackagedDocument = normalizeLineEndings(packagedDocument);
    expect(normalizedPackagedDocument).toBe(normalizedDocument);

    const formalCopy = [
      UI_COPY.intro.title,
      UI_COPY.intro.body,
      UI_COPY.intro.scenario,
      UI_COPY.intro.waiting,
      UI_COPY.header.position,
      UI_COPY.header.sameData,
      UI_COPY.handling.title,
      ...Object.values(UI_COPY.handling.fields),
      ...Object.values(UI_COPY.handling.cloud),
      ...Object.values(UI_COPY.handling.local),
      UI_COPY.processing,
      UI_COPY.result.title,
      UI_COPY.result.metric,
      UI_COPY.result.score,
      UI_COPY.result.label,
      UI_COPY.result.pufferScreen,
      ...Object.values(UI_COPY.footer),
      ...Object.values(UI_COPY.reset),
      ...Object.values(UI_COPY.response),
      UI_COPY.summary.title,
      UI_COPY.summary.body,
      ...UI_COPY.summary.cards,
      ...Object.values(UI_COPY.summary.screenPufferLabels),
      UI_COPY.summary.listLabel,
      ...Object.values(UI_COPY.completed),
      ...Object.values(UI_COPY.aborted),
      ...Object.values(UI_COPY.error),
      ...Object.values(UI_COPY.rehearsal),
    ];
    for (const copy of formalCopy) expect(normalizedDocument).toContain(copy);
  });
});
