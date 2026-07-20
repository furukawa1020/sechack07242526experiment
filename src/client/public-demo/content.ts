export type DemoProcessingLocation = "cloud" | "local";
export type DemoPresentationMode = "label" | "puffer";

export interface PublicDemoCondition {
  readonly processing: DemoProcessingLocation;
  readonly presentation: DemoPresentationMode;
}

/**
 * This public-review sequence is independent from research sessions, forms,
 * logs, network clients, and device adapters. It preserves the public meanings
 * of one approved order without including or exposing internal condition codes.
 */
export const PUBLIC_DEMO_CONDITIONS = Object.freeze([
  Object.freeze({ processing: "cloud", presentation: "label" }),
  Object.freeze({ processing: "local", presentation: "label" }),
  Object.freeze({ processing: "cloud", presentation: "puffer" }),
  Object.freeze({ processing: "local", presentation: "puffer" }),
] as const satisfies readonly PublicDemoCondition[]);

export const PUBLIC_DEMO_FIXED_STATE = Object.freeze({
  score: 72,
  label: "高ストレス",
  pufferLevel: 0.6,
});

export const PUBLIC_DEMO_COPY = Object.freeze({
  notice: {
    title: "公開Mockデモ",
    research: "研究参加用ではありません",
    data: "固定模擬データ・入力／保存／送信なし",
    device: "実機なし",
  },
  intro: {
    title: "同じ身体データを、4つの方法で提示します",
    body: "変わるのは、「どこで処理するか」と「どう伝えるか」です。\n\nあなたは、少し本調子ではないまま作業を続けている場面を想定してください。\n\nどの方法が正しいかを選ぶ課題ではありません。\nそれぞれを見たときに、どう感じたかを覚えておいてください。",
    scenario: "これから表示されるデータの取扱いは、比較のためのシナリオです。\nこの公開デモで、実際の身体データをクラウドへ送信・保存することはありません。",
  },
  presentation: {
    position: (position: number): string => `第${position}提示 / 4`,
    sameData: "同じ固定模擬データを使用しています",
  },
  handling: {
    title: "この提示のデータ取扱い設定",
    fields: {
      processing: "処理場所",
      storage: "保存",
      audience: "閲覧範囲",
    },
    cloud: {
      processing: "クラウド",
      storage: "サーバに保存",
      audience: "本人・所属先の管理者",
    },
    local: {
      processing: "この端末内",
      storage: "保存しない",
      audience: "本人のみ",
    },
  },
  result: {
    title: "現在の状態",
    metric: "状態指標",
    puffer: "状態はフグ型デバイスに\n反映されています",
    deviceNote: "公開デモでは実機は接続・動作していません。",
  },
  footer: {
    scenario: "比較用シナリオ",
    remember: "そのまま見て、感じたことを覚えておいてください。",
    medical: "この表示は医療上の診断ではありません。",
  },
  summary: {
    title: "4つの提示を確認しました",
    body: "これは表示確認専用の公開デモです。研究への参加や回答の送信は行いません。",
    note: "表示した状態値とデータ取扱いは、すべて固定の模擬シナリオです。",
    cards: ["第1提示", "第2提示", "第3提示", "第4提示"],
    conditionLabels: {
      cloud: {
        label: "クラウド × 状態ラベル",
        puffer: "クラウド × フグのふくらみ",
      },
      local: {
        label: "この端末内 × 状態ラベル",
        puffer: "この端末内 × フグのふくらみ",
      },
    },
  },
  navigation: {
    previous: "前へ",
    next: "次へ",
    intro: "導入",
    summary: "サマリー",
  },
});
