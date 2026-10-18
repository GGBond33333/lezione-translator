import {
  estimateConversation,
  estimateLivePerHour,
  estimateRefine,
  formatUsd,
  MODEL_ORDER,
  MODELS,
  OFFLINE_INFO,
  type LiveModelChoice,
  type OnlineModelId,
} from "../core/models-catalog";

interface LiveProps {
  kind: "live";
  value: LiveModelChoice;
  onChange(v: LiveModelChoice): void;
}
interface ConversationProps {
  kind: "conversation";
  value: LiveModelChoice;
  onChange(v: LiveModelChoice): void;
}
interface RefineProps {
  kind: "refine";
  value: OnlineModelId;
  onChange(v: OnlineModelId): void;
  /** 本节课时长（小时），用于显示精修这节课的预估费用 */
  hours?: number;
}

// 双语对话场景下各模型的说明（对话更看重反应速度）
const CONVERSATION_HINTS: Record<LiveModelChoice, string> = {
  offline: "免费、没网也能用；但翻译生硬，不适合正式场合",
  "claude-haiku-5-5": "反应最快、几乎不花钱；问路、点餐、和室友聊天足够用",
  "claude-sonnet-5-5": "办居留、看医生、银行开户、和教授谈话等正式场合更准确，用词更得体",
  "claude-opus-5-5": "最准确，最能理解复杂的长句；每句要多等一会儿",
};

const TAG: Record<string, string> = { live: "实时推荐", refine: "精修推荐", conversation: "对话推荐" };

/** 翻译模型选择卡片：显示优势和预估费用 */
export function ModelPicker(props: LiveProps | ConversationProps | RefineProps) {
  const ids: LiveModelChoice[] = props.kind === "refine" ? MODEL_ORDER : ["offline", ...MODEL_ORDER];

  function pick(id: LiveModelChoice) {
    if (props.kind === "refine") props.onChange(id as OnlineModelId);
    else props.onChange(id);
  }

  return (
    <div>
      {ids.map((id) => {
        const on = props.value === id;
        const info = id === "offline" ? OFFLINE_INFO : MODELS[id];
        const recommended =
          id !== "offline" && (MODELS[id].recommendedFor === props.kind || (props.kind === "conversation" && id === "claude-haiku-5-5"));
        const desc = props.kind === "conversation" ? CONVERSATION_HINTS[id] : info.strengths;
        return (
          <button key={id} className={`model-card${on ? " on" : ""}`} onClick={() => pick(id)}>
            <div className="name">
              {on ? "◉" : "○"} {info.name}
              {recommended && <span className="tag">{TAG[props.kind]}</span>}
            </div>
            <div className="desc">{desc}</div>
            <div className="cost muted">
              {props.kind === "live" && (
                <>
                  <span>
                    每小时 <b>{id === "offline" ? "免费" : `约 ${formatUsd(estimateLivePerHour(id))}`}</b>
                  </span>
                  <span>
                    3 小时课 <b>{id === "offline" ? "免费" : `约 ${formatUsd(estimateLivePerHour(id) * 3)}`}</b>
                  </span>
                </>
              )}
              {props.kind === "conversation" && (
                <>
                  <span>
                    每 100 句 <b>{id === "offline" ? "免费" : `约 ${formatUsd(estimateConversation(id, 100))}`}</b>
                  </span>
                </>
              )}
              {props.kind === "refine" && (
                <>
                  <span>
                    精修 3 小时课 <b>约 {formatUsd(estimateRefine(id as OnlineModelId, 3))}</b>
                  </span>
                  {props.hours !== undefined && (
                    <span>
                      这节课 <b>约 {formatUsd(estimateRefine(id as OnlineModelId, Math.max(props.hours, 0.05)))}</b>
                    </span>
                  )}
                </>
              )}
            </div>
          </button>
        );
      })}
      <p className="muted small">
        {props.kind === "conversation"
          ? "费用为预估值，已包含翻译时参考的前文聊天记录；去一次办事处大约说 50–100 句。"
          : "费用为预估值，按每小时约 600 句计算；实际花费以每节课显示的为准。"}
      </p>
    </div>
  );
}

export function Sheet({ children, onClose }: { children: React.ReactNode; onClose(): void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        {children}
        <button className="btn block" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}
