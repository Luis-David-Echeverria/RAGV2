import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Spherical depth-of-field: keeps everything inside a sphere of `focusRadius`
 * world units centred on the camera perfectly sharp, then blurs linearly out
 * over the next `falloff` world units to `maxBlur`.
 *
 * Distance is real 3D euclidean (not view-Z), so the focus region is a true
 * sphere — a star at the screen edge and one in the centre at the same camera
 * distance get the same treatment, instead of the screen-edge one being
 * "further" because of the wider FOV cone.
 *
 * Cost: one depth-only render of the scene + a 9-tap blur composite.
 */

const FRAGMENT_SHADER = /* glsl */ `
#include <packing>

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float focusRadius;          // world units — sharp inside this radius
uniform float falloff;              // world units — blur ramp width past radius
uniform float maxBlur;              // fraction of screen (e.g. 0.01 = 1%)
uniform vec2  resolution;           // viewport in pixels
uniform mat4  inverseProjection;    // camera.projectionMatrixInverse

float readDepth(vec2 uv) {
  return unpackRGBAToDepth(texture2D(tDepth, uv));
}

// Reconstruct view-space position (camera at origin) from screen UV + depth.
// Then |viewPos| is the true 3D euclidean distance from the camera to the
// fragment — which is what makes the focus region a sphere, not a plane.
vec3 viewSpacePos(vec2 uv) {
  float depth = readDepth(uv);
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 viewPos = inverseProjection * ndc;
  return viewPos.xyz / viewPos.w;
}

void main() {
  vec3 vp = viewSpacePos(vUv);
  float dist = length(vp);  // euclidean distance from camera (sphere test)
  float t = clamp((dist - focusRadius) / max(falloff, 1.0), 0.0, 1.0);
  float blur = t * maxBlur;

  // Separable 9-tap Gaussian-ish kernel (cheap, no bokeh shape but reads
  // smoothly and matches what the eye expects from defocus on starfields).
  vec2 px = vec2(blur) * vec2(resolution.y / resolution.x, 1.0);

  vec4 col = vec4(0.0);
  // Center weight 4, ring-1 weight 2, ring-2 weight 1 — sums to 16.
  col += texture2D(tDiffuse, vUv)                                * 4.0;
  col += texture2D(tDiffuse, vUv + vec2( px.x,  0.0))            * 2.0;
  col += texture2D(tDiffuse, vUv + vec2(-px.x,  0.0))            * 2.0;
  col += texture2D(tDiffuse, vUv + vec2( 0.0,   px.y))           * 2.0;
  col += texture2D(tDiffuse, vUv + vec2( 0.0,  -px.y))           * 2.0;
  col += texture2D(tDiffuse, vUv + vec2( px.x,  px.y) * 0.7071)  * 1.0;
  col += texture2D(tDiffuse, vUv + vec2(-px.x,  px.y) * 0.7071)  * 1.0;
  col += texture2D(tDiffuse, vUv + vec2( px.x, -px.y) * 0.7071)  * 1.0;
  col += texture2D(tDiffuse, vUv + vec2(-px.x, -px.y) * 0.7071)  * 1.0;

  gl_FragColor = col / 16.0;
  gl_FragColor.a = 1.0;
}
`;

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export interface CinematicDoFParams {
  focusRadius?: number;
  falloff?: number;
  maxBlur?: number;
}

interface DoFUniforms {
  tDiffuse:          THREE.IUniform<THREE.Texture | null>;
  tDepth:            THREE.IUniform<THREE.Texture>;
  focusRadius:       THREE.IUniform<number>;
  falloff:           THREE.IUniform<number>;
  maxBlur:           THREE.IUniform<number>;
  resolution:        THREE.IUniform<THREE.Vector2>;
  inverseProjection: THREE.IUniform<THREE.Matrix4>;
}

export class CinematicDoFPass extends Pass {
  public scene: THREE.Scene;
  public camera: THREE.Camera;
  public uniforms: DoFUniforms;

  private renderTargetDepth: THREE.WebGLRenderTarget;
  private materialDepth: THREE.MeshDepthMaterial;
  private materialComposite: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;
  private _oldClearColor = new THREE.Color();

  constructor(scene: THREE.Scene, camera: THREE.Camera, params: CinematicDoFParams = {}) {
    super();
    this.scene = scene;
    this.camera = camera;

    this.renderTargetDepth = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
    });
    this.renderTargetDepth.texture.name = "CinematicDoFPass.depth";

    this.materialDepth = new THREE.MeshDepthMaterial();
    this.materialDepth.depthPacking = THREE.RGBADepthPacking;
    this.materialDepth.blending = THREE.NoBlending;

    this.uniforms = {
      tDiffuse:          { value: null },
      tDepth:            { value: this.renderTargetDepth.texture },
      focusRadius:       { value: params.focusRadius ?? 500 },
      falloff:           { value: params.falloff ?? 500 },
      maxBlur:           { value: params.maxBlur ?? 0.01 },
      resolution:        { value: new THREE.Vector2(1, 1) },
      inverseProjection: { value: new THREE.Matrix4() },
    };

    this.materialComposite = new THREE.ShaderMaterial({
      uniforms: this.uniforms as unknown as { [k: string]: THREE.IUniform },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

    this.fsQuad = new FullScreenQuad(this.materialComposite);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    // 1) Render scene depth into our packed-RGBA depth target.
    this.scene.overrideMaterial = this.materialDepth;

    renderer.getClearColor(this._oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    renderer.setClearColor(0xffffff);
    renderer.setClearAlpha(1.0);
    renderer.setRenderTarget(this.renderTargetDepth);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // 2) Composite blur using readBuffer as colour source.
    this.uniforms.tDiffuse.value = readBuffer.texture;
    const cam = this.camera as THREE.PerspectiveCamera;
    this.uniforms.inverseProjection.value.copy(cam.projectionMatrixInverse);

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      renderer.clear();
      this.fsQuad.render(renderer);
    }

    this.scene.overrideMaterial = null;
    renderer.setClearColor(this._oldClearColor);
    renderer.setClearAlpha(oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }

  setSize(width: number, height: number) {
    this.renderTargetDepth.setSize(width, height);
    (this.uniforms.resolution.value as THREE.Vector2).set(width, height);
  }

  dispose() {
    this.renderTargetDepth.dispose();
    this.materialDepth.dispose();
    this.materialComposite.dispose();
    this.fsQuad.dispose();
  }
}
