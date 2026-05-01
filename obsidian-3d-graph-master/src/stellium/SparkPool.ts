import * as THREE from "three";

const MAX_SPARKS = 1024;
const SPARK_LIFETIME_MS = 380;
const ASSUMED_DT = 1 / 60;

/**
 * Pool of additively-blended point sparks. Spawned at the leading tip of a
 * link trace; each spark drifts outward and fades over SPARK_LIFETIME_MS.
 * One pool is shared across all active traces for cheap GPU usage.
 */
export class SparkPool {
  public readonly object: THREE.Points;

  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly spawnTime: Float32Array;
  private readonly alphas: Float32Array;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;

  constructor(color: string) {
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_SPARKS * 3);
    this.velocities = new Float32Array(MAX_SPARKS * 3);
    this.spawnTime = new Float32Array(MAX_SPARKS);
    this.alphas = new Float32Array(MAX_SPARKS);

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1);
    geo.setAttribute("position", this.positionAttr);
    geo.setAttribute("aAlpha", this.alphaAttr);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uSize: { value: 1.0 },
      },
      vertexShader: `
        attribute float aAlpha;
        uniform float uSize;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uSize * (10.0 * aAlpha + 1.5) * (450.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.0) discard;
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float falloff = 1.0 - smoothstep(0.0, 0.5, d);
          gl_FragColor = vec4(uColor, vAlpha * falloff);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.object = new THREE.Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 999;
    this.object.onBeforeRender = () => this.update();
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const i = this.cursor;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.spawnTime[i] = performance.now();
    this.alphas[i] = 1;
    this.cursor = (this.cursor + 1) % MAX_SPARKS;
  }

  setColor(color: string) {
    this.material.uniforms.uColor!.value.set(color);
  }

  setSize(size: number) {
    this.material.uniforms.uSize!.value = size;
  }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }

  private update() {
    const now = performance.now();
    let dirtyPos = false;
    let dirtyAlpha = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const t0 = this.spawnTime[i]!;
      if (t0 === 0) continue;
      const age = now - t0;
      if (age >= SPARK_LIFETIME_MS) {
        if (this.alphas[i] !== 0) {
          this.alphas[i] = 0;
          this.spawnTime[i] = 0;
          dirtyAlpha = true;
        }
        continue;
      }
      this.positions[i * 3] = this.positions[i * 3]! + this.velocities[i * 3]! * ASSUMED_DT;
      this.positions[i * 3 + 1] = this.positions[i * 3 + 1]! + this.velocities[i * 3 + 1]! * ASSUMED_DT;
      this.positions[i * 3 + 2] = this.positions[i * 3 + 2]! + this.velocities[i * 3 + 2]! * ASSUMED_DT;
      const k = age / SPARK_LIFETIME_MS;
      this.alphas[i] = (1 - k) * (1 - k);
      dirtyPos = true;
      dirtyAlpha = true;
    }
    if (dirtyPos) this.positionAttr.needsUpdate = true;
    if (dirtyAlpha) this.alphaAttr.needsUpdate = true;
  }
}
