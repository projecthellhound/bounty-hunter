import { useState, useEffect } from "react";
import "./KnowledgeGraph.css";

interface Props {
  activeTarget?: string;
  apiBase?: string;
  onViewReport?: (title: string, file: string, target?: string) => void;
}

export default function Brain({ activeTarget }: Props) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [attempts, setAttempts] = useState(0);

  const brainUrl = activeTarget
    ? `http://localhost:3220/?view=programs&program=${encodeURIComponent(activeTarget)}`
    : `http://localhost:3220/`;

  useEffect(() => {
    let active = true;

    const checkStatus = async () => {
      try {
        const res = await fetch("/api/brain/status");
        if (res.ok) {
          const data = await res.json();
          if (active) {
            setOnline(data.online);
            if (!data.online) setAttempts((c) => c + 1);
            return;
          }
        }
      } catch {
        // Fallback probe direct
        fetch("http://localhost:3220/", { mode: "no-cors" })
          .then(() => { if (active) setOnline(true); })
          .catch(() => {
            if (active) {
              setOnline(false);
              setAttempts((c) => c + 1);
            }
          });
      }
    };

    checkStatus();

    const interval = setInterval(() => {
      if (online !== true) {
        checkStatus();
      }
    }, 1200);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [online, attempts]);

  const handleRestart = async () => {
    setOnline(null);
    setAttempts(0);
    try {
      await fetch("/api/brain/start", { method: "POST" });
    } catch {
      // ignore
    }
  };

  return (
    <div className="brain-container" style={{ width: "100%", height: "100%", position: "relative", background: "#13120e", display: "flex", flexDirection: "column" }}>
      {online === false && attempts > 10 && (
        <div style={{ padding: "12px 20px", background: "#1f1d17", borderBottom: "1px solid #322f25", color: "#efe6d0", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.85rem", zIndex: 20 }}>
          <span>
            <strong style={{ color: "#ff6a3d" }}>Brain service taking longer to respond:</strong> Log at <code>/tmp/beast-brain.log</code>.
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={handleRestart}
              style={{ padding: "5px 12px", background: "#2a2720", color: "#ffd580", borderRadius: "4px", border: "1px solid #4a4538", cursor: "pointer", fontSize: "0.8rem" }}
            >
              Restart Engine
            </button>
            <button
              onClick={() => window.open(brainUrl, "_blank")}
              style={{ padding: "5px 12px", background: "#ff6a3d", color: "#13120e", borderRadius: "4px", fontWeight: 600, border: "none", cursor: "pointer", fontSize: "0.8rem" }}
            >
              Open Direct
            </button>
          </div>
        </div>
      )}

      {online !== true && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#13120e", color: "#c6bba5", zIndex: 10 }}>
          <div style={{ width: "36px", height: "36px", borderRadius: "50%", border: "2px solid #322f25", borderTopColor: "#ff6a3d", animation: "brainSpin 0.8s linear infinite", marginBottom: "16px" }} />
          <div style={{ fontFamily: "monospace", letterSpacing: "0.15em", fontSize: "0.85rem", color: "#ff6a3d", fontWeight: 600 }}>INITIALIZING BEAST BRAIN...</div>
          <div style={{ fontSize: "0.75rem", color: "#7a7263", marginTop: "6px" }}>Auto-starting knowledge graph runtime on port 3220</div>
          <style>{`@keyframes brainSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
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
          opacity: online ? 1 : 0,
          transition: "opacity 0.25s ease",
        }}
        allow="clipboard-write"
      />
    </div>
  );
}
