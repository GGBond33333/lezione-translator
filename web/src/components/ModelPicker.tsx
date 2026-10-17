import {
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
interface RefineProps {
  kind: "refine";
  value: OnlineModelId;
  onChange(v: OnlineModelId): void;
  /** 本节课时长（小时），用于显示精修这节课的预估费用 */
  hours?: number;
}

/** 翻译模型选择卡片：显示优势和预估费用 */
export function ModelPicker(props: LiveProps | RefineProps) {
  const ids: LiveModelChoice[] = props.kind === "live" ? ["offline", ...MODEL_ORDER] : MODEL_ORDER;

  return (
    <div>
      {ids.map((id) => {
        const on = props.value === id;
        const info = id === "offline" ? OFFLINE_INFO : MODELS[id];
        const recommended = id !== "offline" && MODELS[id].recommendedFor === props.kind;
        return (
          <button
            key={id}
            className={`model-card${on ? " on" : ""}`}
            onClick={() => (props.kind === "live" ? props.onChange(id) : props.onChange(id as OnlineModelId))}
          >
            <div className="name">
              {on ? "◉" : "○"} {info.name}
              {recommended && <span className="tag">{props.kind === "live" ? "实时推荐" : "精修推荐"}</span>}
            </div>
            <div className="desc">{info.strengths}</div>
            <div className="cost muted">
              {props.kind === "live" ? (
                <>
                  <span>
                    每小时 <b>{id === "offline" ? "免费" : `约 ${formatUsd(estimateLivePerHour(id))}`}</b>
                  </span>
                  <span>
                    3 小时课 <b>{id === "offline" ? "免费" : `约 ${formatUsd(estimateLivePerHour(id) * 3)}`}</b>
                  </span>
                </>
              ) : (
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
      <p className="muted small">费用为预估值，按每小时约 600 句计算；实际花费以每节课显示的为准。</p>
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
