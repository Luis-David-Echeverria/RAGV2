import * as THREE from "three";

const CANVAS_SIZE = 128;

const phaseCache = new Map<string, number>();
function getPhase(nodeId: string): number {
  if (!phaseCache.has(nodeId)) phaseCache.set(nodeId, Math.random() * Math.PI * 2);
  return phaseCache.get(nodeId)!;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean.padEnd(6, "0");
  const n = parseInt(full, 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export interface StelliiumColors {
  coreColor: string;
  haloColor: string;
  sizeMultiplier: number;
  auroraColor1: string;
  auroraColor2: string;
  auroraColor3: string;
  auroraSizeMultiplier: number;
  auroraIntensity: number;
  haloEnabled?: boolean;
}

export const DEFAULT_STELLIUM_COLORS: StelliiumColors = {
  coreColor: "#ffffff",
  haloColor: "#b0c4ff",
  sizeMultiplier: 1.0,
  auroraColor1: "#00e8a0",
  auroraColor2: "#b040ff",
  auroraColor3: "#00c8d0",
  auroraSizeMultiplier: 1.8,
  auroraIntensity: 0.6,
};

function drawStarCanvas(
  canvas: HTMLCanvasElement,
  isAurora: boolean,
  t: number,
  colors: StelliiumColors
): void {
  const ctx = canvas.getContext("2d")!;
  const cx = CANVAS_SIZE / 2;
  const cy = CANVAS_SIZE / 2;
  const r  = CANVAS_SIZE / 2;

  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const core = hexToRgb(colors.coreColor);
  const halo = hexToRgb(colors.haloColor);

  if (isAurora) {
    const c1 = hexToRgb(colors.auroraColor1);
    const c2 = hexToRgb(colors.auroraColor2);
    const c3 = hexToRgb(colors.auroraColor3);
    const k  = colors.auroraIntensity;

    if (colors.haloEnabled) {
      // Outer corona — diffuse, fills the enlarged sprite
      const coronaPulse = 0.7 + 0.3 * Math.sin(t * 0.5);
      const corona = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
      corona.addColorStop(0.00, `rgba(0,0,0,0)`);
      corona.addColorStop(0.45, `rgba(${c3.r},${c3.g},${c3.b},${(0.30 * k * coronaPulse).toFixed(3)})`);
      corona.addColorStop(0.72, `rgba(${c2.r},${c2.g},${c2.b},${(0.22 * k * coronaPulse).toFixed(3)})`);
      corona.addColorStop(0.90, `rgba(${c1.r},${c1.g},${c1.b},${(0.10 * k).toFixed(3)})`);
      corona.addColorStop(1.00, `rgba(0,0,0,0)`);
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Inner glow — tighter, brighter
    const innerPulse = 0.75 + 0.25 * Math.sin(t * 1.1 + 1);
    const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.42);
    inner.addColorStop(0.00, `rgba(${core.r},${core.g},${core.b},1.0)`);
    inner.addColorStop(0.12, `rgba(${core.r},${core.g},${core.b},0.95)`);
    inner.addColorStop(0.30, `rgba(${c1.r},${c1.g},${c1.b},${(0.85 * k * innerPulse).toFixed(3)})`);
    inner.addColorStop(0.60, `rgba(${c2.r},${c2.g},${c2.b},${(0.55 * k * innerPulse).toFixed(3)})`);
    inner.addColorStop(1.00, `rgba(0,0,0,0)`);
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    ctx.fill();

  } else {
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.50);
    grad.addColorStop(0.00, `rgba(${core.r},${core.g},${core.b},1.0)`);
    grad.addColorStop(0.12, `rgba(${core.r},${core.g},${core.b},0.95)`);
    grad.addColorStop(0.30, `rgba(${halo.r},${halo.g},${halo.b},0.55)`);
    grad.addColorStop(0.65, `rgba(${halo.r},${halo.g},${halo.b},0.15)`);
    grad.addColorStop(1.00, `rgba(0,0,0,0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.50, 0, Math.PI * 2);
    ctx.fill();
  }
}

export interface StarSpriteHandle {
  sprite: THREE.Sprite;
  update(
    isAurora: boolean,
    colors: StelliiumColors,
    hovered?: boolean,
    hoverColor?: string,
    skipDraw?: boolean,
    dimFactor?: number,
    pulseFactor?: number,
  ): void;
  dispose(): void;
}

export function createStarSprite(
  nodeId: string,
  degree: number,
  isAurora: boolean,
  colors: StelliiumColors = DEFAULT_STELLIUM_COLORS
): StarSpriteHandle {
  const canvas = document.createElement("canvas");
  canvas.width  = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;

  const phase = getPhase(nodeId);
  drawStarCanvas(canvas, isAurora, 0, colors);

  const texture  = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    fog: true,
  });
  const sprite = new THREE.Sprite(material);

  const baseScale = Math.max(6, Math.log2(degree + 2) * 5) * colors.sizeMultiplier;
  sprite.scale.set(baseScale, baseScale, 1);

  const handle: StarSpriteHandle = {
    sprite,
    update(aurora: boolean, c: StelliiumColors, hovered = false, hoverColor = "#ff6633", skipDraw = false, dimFactor = 1, pulseFactor = 1) {
      const t = Date.now() * 0.0018 + phase;
      const nodeScale = Math.max(6, Math.log2(degree + 2) * 5) * c.sizeMultiplier;

      if (aurora) {
        if (!skipDraw) {
          drawStarCanvas(canvas, true, t, c);
          texture.needsUpdate = true;
        }
        const pulse = 1.0 + 0.20 * Math.sin(t * 0.75);
        const s = nodeScale * c.auroraSizeMultiplier * pulse * (hovered ? 1.25 : 1) * pulseFactor;
        sprite.scale.set(s, s, 1);
        material.opacity = (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 1.1))) * dimFactor;
      } else {
        material.opacity = (0.85 + 0.15 * Math.sin(t * 1.7)) * dimFactor;
        const s = nodeScale * (hovered ? 1.35 : 1) * pulseFactor;
        sprite.scale.set(s, s, 1);
      }

      // Hover tint: multiply sprite colour with hover color
      if (hovered) {
        const hc = hexToRgb(hoverColor);
        material.color.setRGB(hc.r / 255, hc.g / 255, hc.b / 255);
      } else {
        material.color.setRGB(1, 1, 1);
      }
    },
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };

  return handle;
}
