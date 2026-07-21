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

export const PUBLIC_DEMO_INTRO_STEP = 0;
export const PUBLIC_DEMO_FIRST_PRESENTATION_STEP = 1;
export const PUBLIC_DEMO_SUMMARY_STEP = PUBLIC_DEMO_CONDITIONS.length + 1;
export const PUBLIC_DEMO_TOTAL_STEPS = PUBLIC_DEMO_SUMMARY_STEP + 1;

export const PUBLIC_DEMO_FIXED_STATE = Object.freeze({
  score: 72,
  label: "高ストレス",
  pufferLevel: 0.6,
});

export const PUBLIC_DEMO_COPY = Object.freeze({
  notice: {
    title: "公開デモ（模擬表示）",
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
  rehearsal: {
    start: "自動リハーサルを開始",
    stop: "自動リハーサルを終了",
    running: "自動進行中",
    phases: {
      handling: "データ取扱いの確認",
      processing: "処理中",
      result: "結果提示",
      reset: "リセット",
    },
    handling: "データの取扱い設定を確認してください。",
    processing: "固定模擬データを処理しています",
    reset: {
      title: "次の提示に向けてリセットしています",
      body: "そのままお待ちください。",
      puffer: "画面上のフグを収縮させています。実機は動作していません。",
    },
    progress: (position: number, phase: string): string =>
      `第${position}提示 / 4・${phase}`,
  },
  review: {
    operator: {
      title: "公開レビュー進行画面",
      description:
        "固定模擬データの表示を、同じブラウザで開いた参加者画面へ反映します。入力・保存・外部送信は行いません。",
      current: "現在の表示",
      displayLink: "参加者画面を別タブで開く",
      deviceLink: "模擬装置画面を開く",
      connection: "同じブラウザ内だけで同期します",
      scenes: ["共通導入", "第1提示", "第2提示", "第3提示", "第4提示", "サマリー"],
    },
    display: {
      waiting: "進行画面を同じブラウザで開くと、表示が同期されます。",
    },
    device: {
      title: "模擬装置の確認",
      description:
        "実機やUSBシリアルには接続せず、画面上の状態変化だけを確認します。装置命令は送信されません。",
      stateLabel: "模擬装置の状態",
      disconnected: "未接続",
      idle: "待機・収縮済み",
      holding: "膨張状態を模擬中",
      stopped: "停止済み",
      connect: "模擬装置を接続",
      inflate: "膨張を模擬",
      deflate: "収縮を模擬",
      stop: "停止",
      operatorLink: "進行画面へ戻る",
    },
    health: {
      title: "公開レビュー版は正常に配信されています",
      description: "固定模擬データのみ・入力なし・保存なし・実機接続なし",
      operatorLink: "進行画面を開く",
    },
  },
});

export function publicDemoStepLabel(step: number): string {
  if (step === PUBLIC_DEMO_INTRO_STEP) return PUBLIC_DEMO_COPY.navigation.intro;
  if (step === PUBLIC_DEMO_SUMMARY_STEP) return PUBLIC_DEMO_COPY.navigation.summary;
  return PUBLIC_DEMO_COPY.presentation.position(step);
}
