/**
 * Stellium — force-directed knowledge graph for Claude artifacts.
 * Feed with stellium_data JSON: { nodes, edges, sources }
 * Props: data (stellium_data), onNodeClick (optional callback)
 */
import { useEffect, useRef, useState, useCallback } from "react";

const TYPE_COLORS = {
  Concept:       "#6366f1",
  Person:        "#f59e0b",
  Organization:  "#10b981",
  Tool:          "#3b82f6",
  Event:         "#ec4899",
  Location:      "#8b5cf6",
  Document:      "#14b8a6",
  Unknown:       "#6b7280",
};

const color = (type) => TYPE_COLORS[type] ?? TYPE_COLORS.Unknown;

// ── Physics constants ────────────────────────────────────────────────────────
const K_REPEL    = 8000;
const K_ATTRACT  = 0.04;
const K_CENTER   = 0.002;
const DAMPING    = 0.82;
const REST_LEN   = 120;
const DT         = 0.55;

function useForceSimulation(nodes, edges, width, height) {
  const posRef = useRef({});
  const velRef = useRef({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!nodes.length) return;
    // Initialize positions in a circle
    nodes.forEach((n, i) => {
      if (!posRef.current[n.id]) {
        const angle = (2 * Math.PI * i) / nodes.length;
        const r = Math.min(width, height) * 0.3;
        posRef.current[n.id] = {
          x: width / 2 + r * Math.cos(angle),
          y: height / 2 + r * Math.sin(angle),
        };
        velRef.current[n.id] = { x: 0, y: 0 };
      }
    });

    let animId;
    let stable = 0;

    const step = () => {
      const pos = posRef.current;
      const vel = velRef.current;
      const ids = nodes.map((n) => n.id);
      const forces = Object.fromEntries(ids.map((id) => [id, { x: 0, y: 0 }]));

      // Repulsion between all pairs
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i], b = ids[j];
          const dx = pos[a].x - pos[b].x;
          const dy = pos[a].y - pos[b].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = K_REPEL / (dist * dist);
          forces[a].x += (dx / dist) * f;
          forces[a].y += (dy / dist) * f;
          forces[b].x -= (dx / dist) * f;
          forces[b].y -= (dy / dist) * f;
        }
      }

      // Spring attraction along edges
      edges.forEach(({ source, target }) => {
        if (!pos[source] || !pos[target]) return;
        const dx = pos[target].x - pos[source].x;
        const dy = pos[target].y - pos[source].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = K_ATTRACT * (dist - REST_LEN);
        forces[source].x += (dx / dist) * f;
        forces[source].y += (dy / dist) * f;
        forces[target].x -= (dx / dist) * f;
        forces[target].y -= (dy / dist) * f;
      });

      // Center gravity
      ids.forEach((id) => {
        forces[id].x += (width / 2 - pos[id].x) * K_CENTER;
        forces[id].y += (height / 2 - pos[id].y) * K_CENTER;
      });

      // Integrate
      let maxSpeed = 0;
      ids.forEach((id) => {
        vel[id].x = (vel[id].x + forces[id].x * DT) * DAMPING;
        vel[id].y = (vel[id].y + forces[id].y * DT) * DAMPING;
        pos[id].x += vel[id].x * DT;
        pos[id].y += vel[id].y * DT;
        // Clamp to canvas
        pos[id].x = Math.max(20, Math.min(width - 20, pos[id].x));
        pos[id].y = Math.max(20, Math.min(height - 20, pos[id].y));
        maxSpeed = Math.max(maxSpeed, Math.abs(vel[id].x) + Math.abs(vel[id].y));
      });

      setTick((t) => t + 1);

      if (maxSpeed > 0.3) {
        stable = 0;
        animId = requestAnimationFrame(step);
      } else {
        stable++;
        if (stable < 3) animId = requestAnimationFrame(step);
      }
    };

    animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animId);
  }, [nodes, edges, width, height]);

  return posRef.current;
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Stellium({ data, onNodeClick }) {
  const { nodes = [], edges = [], sources = [] } = data ?? {};
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const W = 700, H = 480;

  const pos = useForceSimulation(nodes, edges, W, H);

  const handleNodeClick = useCallback((node) => {
    setSelected(node.id === selected ? null : node.id);
    if (onNodeClick) onNodeClick(node);
  }, [selected, onNodeClick]);

  const selectedNode = nodes.find((n) => n.id === selected);
  const activeEdges = selected
    ? edges.filter((e) => e.source === selected || e.target === selected)
    : edges;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0f0f14", color: "#e2e8f0", borderRadius: 12, overflow: "hidden" }}>
      {/* Graph canvas */}
      <svg width={W} height={H} style={{ display: "block" }}>
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#4b5563" />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((edge, i) => {
          const s = pos[edge.source], t = pos[edge.target];
          if (!s || !t) return null;
          const active = !selected || edge.source === selected || edge.target === selected;
          const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
          return (
            <g key={i} opacity={active ? 1 : 0.12}>
              <line
                x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                stroke="#374151" strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
              {active && edge.label && (
                <text x={mx} y={my - 4} fill="#6b7280" fontSize={9} textAnchor="middle">
                  {edge.label.slice(0, 24)}
                </text>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const p = pos[node.id];
          if (!p) return null;
          const isSelected = node.id === selected;
          const isHovered = node.id === hovered;
          const dimmed = selected && !isSelected &&
            !edges.some((e) => e.source === selected && e.target === node.id ||
                                e.target === selected && e.source === node.id);
          return (
            <g key={node.id}
               transform={`translate(${p.x},${p.y})`}
               style={{ cursor: "pointer" }}
               onClick={() => handleNodeClick(node)}
               onMouseEnter={() => setHovered(node.id)}
               onMouseLeave={() => setHovered(null)}>
              <circle
                r={isSelected ? 14 : isHovered ? 12 : 9}
                fill={color(node.type)}
                opacity={dimmed ? 0.2 : 1}
                stroke={isSelected ? "#fff" : "none"}
                strokeWidth={2}
                style={{ transition: "r 0.15s" }}
              />
              <text
                y={isSelected ? 22 : 18}
                fill={dimmed ? "#4b5563" : "#d1d5db"}
                fontSize={isSelected ? 11 : 9}
                textAnchor="middle"
                style={{ pointerEvents: "none", userSelect: "none" }}>
                {(node.name || node.id).slice(0, 20)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Detail panel */}
      <div style={{ display: "flex", borderTop: "1px solid #1f2937", minHeight: 120 }}>
        {/* Selected node details */}
        <div style={{ flex: 1, padding: 16 }}>
          {selectedNode ? (
            <>
              <div style={{ fontWeight: 600, color: color(selectedNode.type), marginBottom: 4 }}>
                {selectedNode.name || selectedNode.id}
                <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 8 }}>
                  {selectedNode.type}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "#9ca3af", lineHeight: 1.5 }}>
                {selectedNode.description || "No description."}
              </div>
              {activeEdges.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
                  {activeEdges.map((e, i) => (
                    <span key={i} style={{ marginRight: 12 }}>
                      {e.source === selected
                        ? <><span style={{ color: "#d1d5db" }}>{e.target}</span> ← {e.label}</>
                        : <>{e.label} → <span style={{ color: "#d1d5db" }}>{e.source}</span></>
                      }
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: "#4b5563", fontSize: 13 }}>Click a node to inspect it.</div>
          )}
        </div>

        {/* Source cards */}
        {sources.length > 0 && (
          <div style={{
            width: 240, borderLeft: "1px solid #1f2937", padding: "12px 14px",
            overflowY: "auto", maxHeight: 200,
          }}>
            <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
              Sources
            </div>
            {sources.map((src, i) => (
              <div key={i}
                   style={{ marginBottom: 10, cursor: "pointer" }}
                   onClick={() => onNodeClick && onNodeClick({ id: src.id, type: "source", ...src })}>
                <div style={{ fontSize: 12, color: "#a5b4fc", fontWeight: 500 }}>{src.title}</div>
                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                  {src.excerpt?.slice(0, 80)}
                  {src.excerpt?.length > 80 ? "…" : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ padding: "8px 16px", borderTop: "1px solid #111827", display: "flex", flexWrap: "wrap", gap: 12 }}>
        {Object.entries(TYPE_COLORS).filter(([k]) => k !== "Unknown").map(([type, c]) => (
          <div key={type} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#6b7280" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />
            {type}
          </div>
        ))}
      </div>
    </div>
  );
}
