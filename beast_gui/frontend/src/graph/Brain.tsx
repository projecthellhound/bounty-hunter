import { useState, useEffect } from "react";
import "./KnowledgeGraph.css";

interface Props {
  activeTarget?: string;
  apiBase?: string;
  onViewReport?: (title: string, file: string, target?: string) => void;
}

export default function Brain({ activeTarget }: Props) {
  const [online, setOnline] = useState<boolean | null>(null);

  const brainUrl = activeTarget
    ? `http://localhost:3220/?view=programs&program=${encodeURIComponent(activeTarget)}`
    : `http://localhost:3220/`;

  useEffect(() => {
    let live = true;
    fetch("http://localhost:3220/", { mode: "no-cors" })
      .then(() => { if (live) setOnline(true); })
      .catch(() => { if (live) setOnline(false); });
    return () => { live = false; };
  }, [activeTarget]);

  return (
    <div className="brain-container" style={{ width: "100%", height: "100%", position: "relative", background: "#13120e", display: "flex", flexDirection: "column" }}>
      {online === false && (
        <div style={{ padding: "14px 20px", background: "#1f1d17", borderBottom: "1px solid #322f25", color: "#efe6d0", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.85rem" }}>
          <span>
            <strong style={{ color: "#ff6a3d" }}>Brain service offline:</strong> Run <code>pnpm dev --port 3220</code> in <code>beast-brain</code>.
          </span>
          <button
            onClick={() => window.open(brainUrl, "_blank")}
            style={{ padding: "6px 14px", background: "#ff6a3d", color: "#13120e", borderRadius: "5px", fontWeight: 600, border: "none", cursor: "pointer" }}
          >
            Launch Standalone
          </button>
        </div>
      )}
      <iframe
        src={brainUrl}
        title="Beast Brain"
        style={{
          width: "100%",
          flex: 1,
          border: "none",
          background: "#13120e",
        }}
        allow="clipboard-write"
      />
    </div>
  );
}
