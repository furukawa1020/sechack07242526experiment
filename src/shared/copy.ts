import type { PresentationMode, ProcessingLocation } from "./conditions.js";

/** Exact participant-facing copy from docs/UI_COPY.md. */
export const UI_COPY = {
  rehearsal: {
    title: "非参加者用の事前確認",
    body: "研究参加用ではありません・外部回答送信なし",
    summary: "4つの非参加者向け提示を確認しました。\n外部回答の送信は行いません。",
    completedTitle: "非参加者用の事前確認を終了しました",
    completedWaiting: "この画面は研究参加の完了を示すものではありません。",
  },
  intro: {
    title: "同じ固定模擬データを、4つの方法で提示します",
    body: "変わるのは、「どこで処理するか」と「どう伝えるか」です。\n\nあなたは、少し本調子ではないまま作業を続けている場面を想定してください。\n\nどの方法が正しいかを選ぶ課題ではありません。\nそれぞれを見たときに、どう感じたかを覚えておいてください。",
    scenario: "これから表示される値は、比較のために用意した同じ固定模擬データです。\n表示される値は、あなた自身を測定したものではありません。\nこの実験では、心拍その他の生体データを取得しません。\n\nこれから表示されるデータの取扱いは、比較のためのシナリオです。\nこの実験用Webアプリから、固定模擬身体データを外部へ送信・保存することはありません。\n\n画面上のフグは表示だけの表現で、USB機器や実機は接続・動作していません。",
    physicalScenario: "これから表示される値は、比較のために用意した同じ固定模擬データです。\n表示される値は、あなた自身を測定したものではありません。\nこの実験では、心拍その他の生体データを取得しません。\n\nこれから表示されるデータの取扱いは、比較のためのシナリオです。\nこの実験用Webアプリから、固定模擬身体データを外部へ送信・保存することはありません。",
    waiting: "研究スタッフの案内をお待ちください",
  },
  header: {
    position: "第{n}提示 / 4",
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
  processing: "固定模擬データを処理しています…",
  result: {
    title: "現在の状態",
    metric: "状態指標",
    score: "72 / 100",
    label: "高ストレス",
    pufferPhysical: "状態はフグ型デバイスに\n反映されています",
    pufferScreen: "状態は画面上のフグの\nふくらみで表されています",
  },
  footer: {
    scenario: "比較用シナリオ",
    remember: "そのまま見て、感じたことを覚えておいてください。",
    medical: "この表示は医療上の診断ではありません。",
    withdrawal: "参加を途中でやめたい場合は、いつでも研究スタッフへお知らせください。",
  },
  reset: {
    title: "次の提示に移ります",
    waiting: "研究スタッフの案内をお待ちください",
  },
  response: {
    title: "第{n}提示は終了しました",
    waiting: "研究スタッフの案内をお待ちください。",
  },
  summary: {
    title: "4つの提示は終了しました",
    body: "4つの提示は以上です。\n研究スタッフの案内をお待ちください。",
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
    } satisfies Readonly<Record<ProcessingLocation, Readonly<Record<PresentationMode, string>>>>,
    screenPufferLabels: {
      cloud: "クラウド × 画面上のフグのふくらみ",
      local: "この端末内 × 画面上のフグのふくらみ",
    } satisfies Readonly<Record<ProcessingLocation, string>>,
    listLabel: "提示の一覧",
  },
  completed: {
    title: "ご協力ありがとうございました",
    waiting: "研究スタッフの案内をお待ちください",
  },
  aborted: {
    title: "実験を中止しました",
    waiting: "そのまま研究スタッフの案内をお待ちください。",
  },
  error: {
    title: "実験を一時停止しています",
    waiting: "そのまま研究スタッフの案内をお待ちください。",
  },
} as const;

export function formatPresentationPosition(position: 1 | 2 | 3 | 4): string {
  return UI_COPY.header.position.replace("{n}", String(position));
}

export function formatResponseCheckpointTitle(position: 1 | 2 | 3 | 4): string {
  return UI_COPY.response.title.replace("{n}", String(position));
}
