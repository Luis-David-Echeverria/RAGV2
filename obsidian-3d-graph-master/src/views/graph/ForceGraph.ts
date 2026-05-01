import type { ForceGraph3DInstance } from "3d-force-graph";
import ForceGraph3D from "3d-force-graph";
import { Graph } from "@/graph/Graph";
import { CenterCoordinates } from "@/views/graph/CenterCoordinates";
import * as THREE from "three";
import * as d3 from "d3-force-3d";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CinematicDoFPass } from "@/stellium/CinematicDoFPass";
import { hexToRGBA } from "@/util/hexToRGBA";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { FOCAL_FROM_CAMERA, ForceGraphEngine } from "@/views/graph/ForceGraphEngine";
import type { DeepPartial } from "ts-essentials";
import type { Node } from "@/graph/Node";
import { createStarSprite, type StarSpriteHandle } from "@/stellium/StarSprite";
import { SparkPool } from "@/stellium/SparkPool";

import { rgba } from "polished";
import { createNotice } from "@/util/createNotice";
import type { GlobalGraphSettings, GraphSetting, LocalGraphSettings } from "@/SettingsSchemas";
import { DagOrientation } from "@/SettingsSchemas";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import type { BaseGraph3dView, Graph3dView } from "@/views/graph/3dView/Graph3dView";
import type { ItemView, TFile } from "obsidian";
import type { GraphSettingManager } from "@/views/settings/graphSettingManagers/GraphSettingsManager";
import { syncOf } from "@/util/awaitof";

export const getTooManyNodeMessage = (nodeNumber: number) =>
  `Graph is too large to be rendered. Have ${nodeNumber} nodes.`;

type MyForceGraph3DInstance = Omit<ForceGraph3DInstance, "graphData"> & {
  graphData: {
    (): Graph; // When no argument is passed, it returns a Graph
    (graph: Graph): MyForceGraph3DInstance; // When a Graph is passed, it returns MyForceGraph3DInstance
  };
};

export type BaseForceGraph = ForceGraph<BaseGraph3dView>;

/**
 * this class control the config and graph of the force graph. The interaction is not control here.
 */
export class ForceGraph<V extends Graph3dView<GraphSettingManager<GraphSetting, V>, ItemView>> {
  /**
   * this can be a local graph or a global graph
   */
  public readonly view: V;
  // private config: LocalGraphSettings | GlobalGraphSettings;

  public readonly instance: MyForceGraph3DInstance;
  public readonly centerCoordinates: CenterCoordinates;
  public readonly myCube: THREE.Mesh;

  public readonly interactionManager: ForceGraphEngine;
  public nodeLabelEl: HTMLDivElement;

  // stellium: live map of node path → star sprite handle for animation & disposal
  public readonly starSprites = new Map<string, StarSpriteHandle>();

  // Spark trail pool — emitted at the leading tip of every active link trace
  public readonly sparkPool: SparkPool = new SparkPool("#ffffff");

  // frustum culling — shared across all label onAfterRender callbacks, updated once per frame
  private _frustum = new THREE.Frustum();
  private _projScreenMatrix = new THREE.Matrix4();
  private _lastFrustumTime = 0;

  // P3: GPU instanced mesh for default (non-stellium) sphere nodes
  private _instancedMesh: THREE.InstancedMesh | null = null;
  private _nodeInstanceIndex = new Map<string, number>();
  private _dummy = new THREE.Object3D();
  private _instanceColor = new THREE.Color();

  // Dev overlay
  private _devOverlay: HTMLDivElement | null = null;
  private _devFrameCount = 0;
  private _devLastTime = 0;
  private _devFps = 0;
  private _devLabelCulled = 0;
  private _devLabelTotal = 0;

  // Global frame counter (never resets — used for frame-skip logic)
  private _globalFrame = 0;

  // Aurora quick-toggle button
  private _auroraButton: HTMLDivElement | null = null;
  private _lastAuroraState: boolean | null = null;

  // Postprocessing passes
  private _bloomPass: UnrealBloomPass | null = null;
  private _dofPass: CinematicDoFPass | null = null;
  private _lastFogColor: string | null = null;

  // DoF: amortise the O(N) nearest-node scan over time (~15 Hz refresh)
  private _nearestNodeDist = 0;
  private _nearestNodeAt = 0;

  /**
   *
   * this will create a new force graph instance and render it to the view
   * @param view
   * @param config you have to provide the full config here!!
   */
  constructor(view: V, _graph: Graph) {
    this.view = view;
    this.interactionManager = new ForceGraphEngine(this);

    const pluginSetting = this.view.plugin.settingManager.getSettings().pluginSetting;
    const determineTooManyNode = () => {
      const tooMany = _graph.nodes.length > pluginSetting.maxNodeNumber;
      if (tooMany) createNotice(getTooManyNodeMessage(_graph.nodes.length));
    };

    determineTooManyNode();

    const graph = _graph;

    // create the div element for the node label
    const { divEl, nodeLabelEl } = this.createNodeLabel();
    this.nodeLabelEl = nodeLabelEl;
    // create the instance
    // these config will not changed by user
    this.instance = ForceGraph3D({
      controlType: pluginSetting.rightClickToPan ? undefined : "orbit",
      extraRenderers: [
        // @ts-ignore https://github.com/vasturiano/3d-force-graph/blob/522d19a831e92015ff77fb18574c6b79acfc89ba/example/html-nodes/index.html#L27C9-L29
        new CSS2DRenderer({
          element: divEl,
        }),
      ],
    })(this.view.contentEl)
      .graphData(graph)
      .nodeColor(this.interactionManager.getNodeColor)
      // @ts-ignore
      .nodeLabel((node) => null)
      // node size: logarithmic scale so hubs are visually dominant without drowning orphans
      .nodeVal((node: Node) => {
        const isCurrent =
          "currentFile" in this.view && (this.view.currentFile as TFile)?.path === node.path;
        const base = Math.max(1, Math.log2(node.links.length + 2)) * 3;
        return base * (isCurrent ? 2.5 : 1);
      })
      .onBackgroundRightClick(() => {
        this.interactionManager.removeSelection();
      })
      .nodeOpacity(0.9)
      .linkOpacity(0.3)
      .onNodeHover(this.interactionManager.onNodeHover)
      .onNodeDrag(this.interactionManager.onNodeDrag)
      .onNodeDragEnd(this.interactionManager.onNodeDragEnd)
      .onNodeRightClick(this.interactionManager.onNodeRightClick)
      .onNodeClick(this.interactionManager.onNodeClick)
      // .onLinkHover(this.interactionManager.onLinkHover)
      .linkColor(this.interactionManager.getLinkColor)
      .linkWidth(this.interactionManager.getLinkWidth)
      .linkDirectionalParticles(this.interactionManager.getLinkDirectionalParticles)
      .linkDirectionalParticleWidth(this.interactionManager.getLinkDirectionalParticleWidth)
      .linkDirectionalParticleSpeed(this.interactionManager.getLinkDirectionalParticleSpeed)
      .linkDirectionalParticleColor(this.interactionManager.getLinkDirectionalParticleColor)
      // ── Trace animation: animated line overlay on threads-mode links ──────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .linkThreeObject((link: any) => {
        const TRACE_SEGS = 32;
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array((TRACE_SEGS + 1) * 3);
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geo.setDrawRange(0, 0);
        const mat = new THREE.LineBasicMaterial({
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const line = new THREE.Line(geo, mat);
        // Tag the line on the link so the per-render-frame hook can drive
        // its animation state independently of d3's simulation tick.
        link.__traceLine = line;
        return line;
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .linkPositionUpdate((obj: any, coords: any, _link: any) => {
        // Only refresh the line buffer to follow source/target node movement.
        // The trace state machine (highlight ramp / aurora phase / decay /
        // sparks / arrival) lives in scene().onBeforeRender so it keeps
        // running after the d3 simulation cools down.
        const TRACE_SEGS = 32;
        const line = obj as THREE.Line;
        line.visible = true;
        const posAttr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
        const { start, end } = coords;
        for (let i = 0; i <= TRACE_SEGS; i++) {
          const t = i / TRACE_SEGS;
          posAttr.setXYZ(
            i,
            start.x + (end.x - start.x) * t,
            start.y + (end.y - start.y) * t,
            start.z + (end.z - start.z) * t
          );
        }
        posAttr.needsUpdate = true;
        return true;
      })
      .linkThreeObjectExtend(true)
      // the options here are auto
      .width(this.view.contentEl.innerWidth)
      .height(this.view.contentEl.innerHeight)
      .d3Force("collide", d3.forceCollide(5))
      //   transparent
      .backgroundColor(hexToRGBA(
        this.view.settingManager.getCurrentSetting().display.backgroundColor ?? "#000000", 1
      )) as unknown as MyForceGraph3DInstance;

    const scene = this.instance.scene();
    const renderer = this.instance.renderer();
    renderer.domElement.addEventListener("wheel", (e) => this.interactionManager.onZoom(e));
    // add others things
    // add center coordinates
    this.centerCoordinates = new CenterCoordinates(
      this.view.settingManager.getCurrentSetting().display.showCenterCoordinates
    );
    scene.add(this.centerCoordinates.arrowsGroup);

    this.myCube = this.createCube();
    scene.add(this.myCube);

    // Spark trail pool — drives the dispersing tip on active link traces
    scene.add(this.sparkPool.object);

    // A7: fog setup
    this._setupFog(scene);

    // A1 + A5: postprocessing passes (bloom, DoF)
    this._setupPostprocessing();

    // P3: build instanced mesh before nodeThreeObject runs (non-stellium mode only)
    const initSettings = this.view.settingManager.getCurrentSetting();
    if (!initSettings.display.stelliumMode) {
      this._buildInstancedMesh(graph, scene);
    }

    // Dev overlay
    if (initSettings.display.devMode) {
      this._createDevOverlay();
    }

    // Aurora quick-toggle button (always visible)
    this._createAuroraButton();

    // add node label + optional star sprite
    this.instance
      .nodeThreeObject((node: Node) => {
        const settings = this.view.settingManager.getCurrentSetting();

        // ── Label (CSS2DObject) ───────────────────────────────────────────────
        const nodeEl = document.createElement("div");
        const text = this.interactionManager.getNodeLabelText(node);
        nodeEl.textContent = text;
        // @ts-ignore
        nodeEl.style.color = node.color;
        nodeEl.className = "node-label";
        nodeEl.style.top = "20px";
        nodeEl.style.fontSize = "12px";
        nodeEl.style.padding = "1px 4px";
        nodeEl.style.borderRadius = "4px";
        nodeEl.style.backgroundColor = rgba(0, 0, 0, 0.5);
        nodeEl.style.userSelect = "none";

        const cssObject = new CSS2DObject(nodeEl);
        cssObject.onAfterRender = () => {
          const camera = this.instance.camera() as THREE.PerspectiveCamera;

          // Update frustum at most once per frame (all nodes share the same frustum instance)
          const frameKey = Math.floor(performance.now() / 16);
          if (frameKey !== this._lastFrustumTime) {
            this._projScreenMatrix.multiplyMatrices(
              camera.projectionMatrix,
              camera.matrixWorldInverse
            );
            this._frustum.setFromProjectionMatrix(this._projScreenMatrix);
            this._lastFrustumTime = frameKey;
          }

          // @ts-ignore
          const obj = node.__threeObj as THREE.Object3D | undefined;
          const pos = obj?.position;

          // Priority: when focus is active (hover or selection), only labels of
          // focused nodes (the focused node + its neighbors) are visible. This
          // overrides distance / frustum culling so the user always sees what
          // they're investigating.
          const focusActive = this.interactionManager.getIsAnyHighlighted();
          if (focusActive) {
            if (!this.interactionManager.isHighlightedNode(node)) {
              this._devLabelCulled++;
              this._devLabelTotal++;
              nodeEl.style.display = "none";
              return;
            }
            this._devLabelTotal++;
            nodeEl.style.display = "";
            nodeEl.style.opacity = "1";
            return;
          }

          if (pos) {
            const cullDist =
              this.view.settingManager.getCurrentSetting().display.labelCullDistance ?? 800;
            if (!this._frustum.containsPoint(pos) || camera.position.distanceTo(pos) > cullDist) {
              this._devLabelCulled++;
              this._devLabelTotal++;
              nodeEl.style.display = "none";
              return;
            }
          }

          nodeEl.style.display = "";
          const opacity = 1 - this.interactionManager.getNodeOpacityEasedValue(node);

          // opacity near-zero → remove from DOM paint pipeline entirely
          if (opacity < 0.01) {
            this._devLabelCulled++;
            this._devLabelTotal++;
            nodeEl.style.display = "none";
            return;
          }
          this._devLabelTotal++;
          nodeEl.style.opacity = `${opacity}`;
        };
        node.labelEl = nodeEl;

        if (!settings.display.stelliumMode) {
          // P3: invisible proxy sphere for raycasting + label (InstancedMesh handles visual rendering)
          const val = Math.max(1, Math.log2(node.links.length + 2)) * 3;
          const proxySphere = new THREE.Mesh(
            new THREE.SphereGeometry(1, 8, 6),
            new THREE.MeshBasicMaterial()
          );
          proxySphere.scale.setScalar(Math.cbrt(val) * 4);
          proxySphere.visible = false;
          const proxyGroup = new THREE.Group();
          proxyGroup.add(proxySphere);
          proxyGroup.add(cssObject);
          return proxyGroup;
        }

        // ── Stellium star sprite (replaces the default sphere) ───────────────
        // Dispose any previous handle for this node
        this.starSprites.get(node.path)?.dispose();
        const isAurora = this.interactionManager.isAuroraNode(node);
        const d = settings.display;
        const handle = createStarSprite(node.path, node.links.length, isAurora, {
          coreColor: d.starCoreColor ?? "#ffffff",
          haloColor: d.starHaloColor ?? "#b0c4ff",
          sizeMultiplier: d.starSizeMultiplier ?? 1.0,
          auroraColor1: d.auroraColor1 ?? "#00e8a0",
          auroraColor2: d.auroraColor2 ?? "#b040ff",
          auroraColor3: d.auroraColor3 ?? "#00c8d0",
          auroraSizeMultiplier: d.auroraSizeMultiplier ?? 1.8,
          auroraIntensity: d.auroraIntensity ?? 0.6,
        });
        this.starSprites.set(node.path, handle);

        // Mount the CSS2D label onto the sprite group
        handle.sprite.add(cssObject);

        return handle.sprite;
      })
      // always replace default sphere: either star sprite (stellium) or proxy+InstancedMesh (default)
      .nodeThreeObjectExtend(false);

    // init other setting
    this.updateConfig(this.view.settingManager.getCurrentSetting());

    // this disable the right click to pan
    if (!pluginSetting.rightClickToPan) {
      const controls = this.instance.controls() as OrbitControls;
      controls.mouseButtons.RIGHT = undefined;
      // also if right click to pan cmd + left pan should be disabled
      // to disable it, we just need to remove the orbit controls
    }

    //  change the nav info text
    this.view.contentEl
      .querySelector(".scene-nav-info")
      ?.setText(
        `Left-click: rotate, Mouse-wheel/middle-click: zoom, ${
          pluginSetting.rightClickToPan ? "Right click" : "Cmd + left click"
        }: pan`
      );
  }

  private createNodeLabel() {
    const divEl = document.createElement("div");
    divEl.style.zIndex = "0";
    const nodeLabelEl = divEl.createDiv({
      cls: "node-label",
      text: "",
    });
    nodeLabelEl.style.opacity = "0";
    return { divEl, nodeLabelEl };
  }

  private createCube() {
    // add cube
    const myCube = new THREE.Mesh(
      new THREE.BoxGeometry(30, 30, 30),
      new THREE.MeshBasicMaterial({ color: 0xff0000 })
    );

    myCube.position.set(0, 0, -FOCAL_FROM_CAMERA);

    const oldOnBeforeRender = this.instance.scene().onBeforeRender;

    this.instance.scene().onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      oldOnBeforeRender(renderer, scene, camera, geometry, material, group);

      // Dev overlay: read previous frame's counters, then reset for this frame
      const devSettings = this.view.settingManager.getCurrentSetting().display;
      if (devSettings.devMode) {
        if (!this._devOverlay) this._createDevOverlay();
        this._devFrameCount++;
        const now = performance.now();
        if (now - this._devLastTime >= 500) {
          this._devFps = Math.round(this._devFrameCount / (now - this._devLastTime) * 1000);
          this._devFrameCount = 0;
          this._devLastTime = now;
          this._updateDevOverlayContent();
        }
        this._devLabelCulled = 0;
        this._devLabelTotal = 0;
      } else if (this._devOverlay) {
        this._destroyDevOverlay();
      }

      const cwd = new THREE.Vector3();
      camera.getWorldDirection(cwd);
      cwd.multiplyScalar(FOCAL_FROM_CAMERA);
      cwd.add(camera.position);
      myCube.position.set(cwd.x, cwd.y, cwd.z);
      myCube.setRotationFromQuaternion(camera.quaternion);

      // P3: update instanced mesh positions + colors every frame
      if (this._instancedMesh) {
        this._updateInstancedMesh();
      }

      // Sync aurora button label if the underlying setting changed
      this._syncAuroraButton();

      // Sync postprocessing passes + fog with current settings
      this._syncEffects();

      // ── Trace animation state (decoupled from d3 simulation tick) ─────────────
      // This block runs every render frame regardless of whether the force
      // simulation is still ticking. It owns: highlighted-trace ramp, aurora
      // phase oscillator, decay back to 0, spark spawning, and the
      // "trace arrived" callback that drives reveal-gating + the focus pulse.
      this._tickTraces();

      // stellium: animate star sprites every frame (with frame-skip + distance LOD)
      if (this.starSprites.size > 0) {
        this._globalFrame++;
        const d = this.view.settingManager.getCurrentSetting().display;
        const colors = {
          coreColor: d.starCoreColor ?? "#ffffff",
          haloColor: d.starHaloColor ?? "#b0c4ff",
          sizeMultiplier: d.starSizeMultiplier ?? 1.0,
          auroraColor1: d.auroraColor1 ?? "#00e8a0",
          auroraColor2: d.auroraColor2 ?? "#b040ff",
          auroraColor3: d.auroraColor3 ?? "#00c8d0",
          auroraSizeMultiplier: d.auroraSizeMultiplier ?? 1.8,
          auroraIntensity: d.auroraIntensity ?? 0.6,
          haloEnabled: d.auroraHaloEnabled ?? false,
        };
        const dimmedColors = { ...colors, auroraIntensity: d.auroraIntensityFocused ?? 0.15 };
        const directColor   = d.nodeHoverColor ?? "#ff6633";
        const neighborColor = d.nodeHoverNeighbourColor ?? "#00ff00";
        const cullDist = d.labelCullDistance ?? 800;
        const camPos = (camera as THREE.PerspectiveCamera).position;
        const focusActive = this.interactionManager.getIsAnyHighlighted();
        // skip aurora canvas redraw on odd frames (keeps animation smooth, halves GPU uploads)
        const skipDraw = this._globalFrame % 2 === 1;

        const PULSE_DURATION = 280;
        const nowMs = performance.now();
        // Drop expired pulse triggers so the map doesn't grow unbounded
        this.interactionManager.pulseTriggers.forEach((startedAt, id) => {
          if (nowMs - startedAt > PULSE_DURATION) {
            this.interactionManager.pulseTriggers.delete(id);
          }
        });

        this.starSprites.forEach((handle, path) => {
          const node = this.instance.graphData().getNodeByPath(path);
          if (!node) return;

          const isDirect   = this.interactionManager.hoveredNode === node;
          const isInFocus  = focusActive && this.interactionManager.isHighlightedNode(node);

          // LOD: hide sprites beyond cull distance — but never hide focused stars
          const dist = camPos.distanceTo(handle.sprite.position);
          if (dist > cullDist && !isInFocus) {
            handle.sprite.visible = false;
            return;
          }
          handle.sprite.visible = true;

          const isNeighbor = isInFocus && !isDirect;
          // Non-focused stars get dimmed aurora intensity AND a global opacity dim
          const colorsForThisNode = focusActive && !isInFocus ? dimmedColors : colors;
          const dimFactor = focusActive && !isInFocus ? 0.25 : 1;

          // Arrival pulse: temporary scale spike when an incoming trace lands
          let pulseFactor = 1;
          const pulseStart = this.interactionManager.pulseTriggers.get(node.id);
          if (pulseStart !== undefined) {
            const k = (nowMs - pulseStart) / PULSE_DURATION;
            if (k >= 0 && k <= 1) {
              const env = (1 - k) * (1 - k);
              pulseFactor = 1 + 0.45 * env;
            }
          }

          // never skip draw for hovered nodes — their aurora must stay perfectly in sync
          handle.update(
            this.interactionManager.isAuroraNode(node),
            colorsForThisNode,
            isDirect || isNeighbor,
            isDirect ? directColor : neighborColor,
            skipDraw && !isDirect,
            dimFactor,
            pulseFactor,
          );
        });
      }
    };
    myCube.visible = false;
    return myCube;
  }

  /**
   * release GPU resources and remove event listeners — call before _destructor()
   */
  public dispose() {
    this.interactionManager.destroy();
    this.myCube.geometry.dispose();
    (this.myCube.material as THREE.Material).dispose();
    this.starSprites.forEach((handle) => handle.dispose());
    this.starSprites.clear();
    this.instance.scene().remove(this.sparkPool.object);
    this.sparkPool.dispose();
    if (this._instancedMesh) {
      this.instance.scene().remove(this._instancedMesh);
      this._instancedMesh.geometry.dispose();
      (this._instancedMesh.material as THREE.Material).dispose();
      this._instancedMesh = null;
      this._nodeInstanceIndex.clear();
    }
    this._destroyDevOverlay();
    this._destroyAuroraButton();
    // Dispose postprocessing passes
    this._bloomPass?.dispose?.();
    this._bloomPass = null;
    this._dofPass?.dispose?.();
    this._dofPass = null;
  }

  /**
   * Per-render-frame trace state machine. Runs even when d3 has cooled, so
   * hover/select animations always play instead of freezing until the next
   * simulation reheat. Iterates all links once — O(N), same big-O as the
   * old per-tick callback, but driven by RAF instead of by d3 ticks.
   */
  private _tickTraces() {
    const settings = this.view.settingManager.getCurrentSetting();
    const TRACE_SEGS = 32;
    const focusActive = this.interactionManager.getIsAnyHighlighted();
    const durationMs = Math.max(50, settings.display.traceDurationMs ?? 500);
    const inc = (1000 / 60) / durationMs;
    const auroraColor = settings.display.auroraColor1 ?? "#00e8a0";
    const auroraIntensity = Math.max(0.35, settings.display.auroraIntensity ?? 0.6);

    // Sync spark uniform once per frame (cheap: one uniform write)
    this.sparkPool.setSize(settings.display.sparkSize ?? 1.0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const links = this.instance.graphData().links as any[];
    for (let li = 0; li < links.length; li++) {
      const link = links[li];
      const line = link.__traceLine as THREE.Line | undefined;
      if (!line) continue;
      const geo = line.geometry as THREE.BufferGeometry;
      const mat = line.material as THREE.LineBasicMaterial;

      const isHighlighted = this.interactionManager.highlightedLinks.has(link);
      const isAurora = this.interactionManager.isAuroraLink(link);

      if (isAurora) {
        if (focusActive && !isHighlighted) {
          geo.setDrawRange(0, 0);
          mat.opacity = 0;
        } else {
          const phase = (((link.__tracePhase as number) ?? Math.random()) + 0.018) % 1;
          link.__tracePhase = phase;
          const segCount = Math.floor(0.45 * (TRACE_SEGS + 1));
          const segStart = Math.min(
            Math.floor(phase * (TRACE_SEGS + 1)),
            TRACE_SEGS + 1 - segCount
          );
          geo.setDrawRange(segStart, segCount);
          mat.color.set(auroraColor);
          mat.opacity = auroraIntensity;
        }
      } else if (isHighlighted) {
        const prevP: number = (link.__traceP as number) ?? 0;
        const p = Math.min(prevP + inc, 1);
        link.__traceP = p;
        geo.setDrawRange(0, Math.ceil(p * (TRACE_SEGS + 1)));
        mat.color.set(0xffffff);
        mat.opacity = 0.9;

        // Sparks at the leading tip while the trace is drawing
        if (p < 1 && link.source && link.target) {
          const sx = link.source.x ?? 0;
          const sy = link.source.y ?? 0;
          const sz = link.source.z ?? 0;
          const ex = link.target.x ?? 0;
          const ey = link.target.y ?? 0;
          const ez = link.target.z ?? 0;
          const tipX = sx + (ex - sx) * p;
          const tipY = sy + (ey - sy) * p;
          const tipZ = sz + (ez - sz) * p;
          for (let s = 0; s < 4; s++) {
            const vx = (Math.random() - 0.5) * 22;
            const vy = (Math.random() - 0.5) * 22;
            const vz = (Math.random() - 0.5) * 22;
            this.sparkPool.spawn(tipX, tipY, tipZ, vx, vy, vz);
          }
        }

        // Trace just crossed 1 → notify engine (reveal destination / pulse focus)
        if (p >= 1 && prevP < 1 && !link.__traceArrived) {
          link.__traceArrived = true;
          this.interactionManager.onTraceArrived(link);
        }
      } else {
        let p: number = (link.__traceP as number) ?? 0;
        if (p <= 0) {
          // Already decayed — skip the geometry write to save work
          if (mat.opacity !== 0) {
            geo.setDrawRange(0, 0);
            mat.opacity = 0;
          }
          continue;
        }
        p = Math.max(p - 0.15, 0);
        link.__traceP = p;
        if (p <= 0) {
          geo.setDrawRange(0, 0);
          mat.opacity = 0;
        } else {
          geo.setDrawRange(0, Math.ceil(p * (TRACE_SEGS + 1)));
          mat.opacity = 0.9 * p;
        }
      }
    }
  }

  private _setupFog(scene: THREE.Scene) {
    const d = this.view.settingManager.getCurrentSetting().display;
    if (!d.fogEnabled) return;
    const color = d.backgroundColor ?? "#000000";
    const far = d.fogFar ?? 1500;
    scene.fog = new THREE.Fog(color, far / 4, far);
    this._lastFogColor = color;
  }

  private _setupPostprocessing() {
    // 3d-force-graph exposes its EffectComposer via postProcessingComposer()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const composer = (this.instance as any).postProcessingComposer?.();
    if (!composer) return;
    const d = this.view.settingManager.getCurrentSetting().display;
    const w = this.view.contentEl.offsetWidth || 800;
    const h = this.view.contentEl.offsetHeight || 600;

    // Bloom — half-resolution to keep it cheap on integrated GPUs
    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w * 0.5, h * 0.5),
      d.bloomStrength ?? 0.6,
      0.5, // radius (kept fixed; threshold + strength are the real knobs)
      d.bloomThreshold ?? 0.7,
    );
    this._bloomPass.enabled = d.bloomEnabled ?? true;
    composer.addPass(this._bloomPass);

    // Cinematic depth of field — sharp inside `focusRadius` from the camera,
    // linearly defocused over `falloff` world units beyond that.
    const camera = this.instance.camera() as THREE.PerspectiveCamera;
    const initFocusRadius = d.dofFocusZone ?? 500;
    const initMaxBlur = d.dofMaxBlur ?? 0.01;
    this._dofPass = new CinematicDoFPass(this.instance.scene(), camera, {
      focusRadius: initFocusRadius,
      falloff: initFocusRadius,
      maxBlur: initMaxBlur,
    });
    this._dofPass.enabled = d.dofEnabled ?? false;
    composer.addPass(this._dofPass);
  }

  private _syncEffects() {
    const d = this.view.settingManager.getCurrentSetting().display;
    const scene = this.instance.scene();
    const camera = this.instance.camera() as THREE.PerspectiveCamera;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controls = this.instance.controls() as any;
    const target =
      controls?.target instanceof THREE.Vector3 ? controls.target : new THREE.Vector3(0, 0, 0);

    // Distance from camera to its orbit target — defines the "interest scale".
    // Adaptive fog/DoF use this so behaviour stays sensible at any zoom level.
    const D = camera.position.distanceTo(target);

    // Fog sync — adaptive
    if (d.fogEnabled) {
      const color = d.backgroundColor ?? "#000000";
      const userFar = d.fogFar ?? 1500;
      // fog covers a band around D so things "near where the camera is looking" are sharp
      const far = Math.max(D + userFar, userFar);
      const near = Math.max(D - userFar * 0.8, 50);
      if (!scene.fog) {
        scene.fog = new THREE.Fog(color, near, far);
      } else if (scene.fog instanceof THREE.Fog) {
        if (this._lastFogColor !== color) {
          scene.fog.color.set(color);
          this._lastFogColor = color;
        }
        scene.fog.near = near;
        scene.fog.far = far;
      }
    } else if (scene.fog) {
      scene.fog = null;
    }

    // Bloom sync
    if (this._bloomPass) {
      this._bloomPass.enabled = d.bloomEnabled ?? true;
      this._bloomPass.strength = d.bloomStrength ?? 0.6;
      this._bloomPass.threshold = d.bloomThreshold ?? 0.7;
    }

    // DoF sync — sphere of clarity centred on the camera. Radius is
    // dynamic: nearest-node distance + user "padding" — guarantees that the
    // closest star is always sharp, no matter how the user pans/zooms.
    if (this._dofPass) {
      this._dofPass.enabled = d.dofEnabled ?? false;
      if (this._dofPass.enabled) {
        const padding = d.dofFocusZone ?? 500;
        const maxBlur = d.dofMaxBlur ?? 0.01;
        const nearest = this._computeNearestNodeDistance(camera);
        const focusRadius = nearest + padding;
        const u = this._dofPass.uniforms;
        u.focusRadius.value = focusRadius;
        u.falloff.value = padding;
        u.maxBlur.value = maxBlur;
      }
    }
  }

  /**
   * Distance from the camera to the closest node in world units.
   * Refreshed at ~15 Hz — fast enough to track pan/zoom without lag, but
   * keeps the per-frame cost negligible on large graphs.
   */
  private _computeNearestNodeDistance(camera: THREE.PerspectiveCamera): number {
    const now = performance.now();
    if (now - this._nearestNodeAt < 66 && this._nearestNodeDist > 0) {
      return this._nearestNodeDist;
    }
    const nodes = this.instance.graphData().nodes as (Node & {
      x?: number; y?: number; z?: number;
    })[];
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    let minSq = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.x == null || n.y == null || n.z == null) continue;
      const dx = n.x - cx, dy = n.y - cy, dz = n.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minSq) minSq = d2;
    }
    this._nearestNodeDist = isFinite(minSq) ? Math.sqrt(minSq) : 0;
    this._nearestNodeAt = now;
    return this._nearestNodeDist;
  }

  private _buildInstancedMesh(graph: Graph, scene: THREE.Scene) {
    const count = graph.nodes.length;
    if (count === 0) return;
    const geo = new THREE.SphereGeometry(1, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ opacity: 0.9, transparent: true, fog: true });
    this._instancedMesh = new THREE.InstancedMesh(geo, mat, count);
    this._instancedMesh.frustumCulled = false;
    graph.nodes.forEach((node, i) => {
      this._nodeInstanceIndex.set(node.id, i);
      this._instanceColor.set(0x888888);
      this._instancedMesh!.setColorAt(i, this._instanceColor);
    });
    scene.add(this._instancedMesh);
  }

  private _updateInstancedMesh() {
    const mesh = this._instancedMesh!;
    const nodes = this.instance.graphData().nodes as (Node & { x?: number; y?: number; z?: number })[];
    const currentPath = "currentFile" in this.view ? (this.view.currentFile as TFile)?.path : null;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const val = Math.max(1, Math.log2(node.links.length + 2)) * 3 * (node.path === currentPath ? 2.5 : 1);
      this._dummy.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
      this._dummy.scale.setScalar(Math.cbrt(val) * 4);
      this._dummy.updateMatrix();
      mesh.setMatrixAt(i, this._dummy.matrix);
      this._instanceColor.set(this.interactionManager.getNodeColor(node));
      mesh.setColorAt(i, this._instanceColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private _createDevOverlay() {
    if (this._devOverlay) return;
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:absolute", "top:8px", "left:8px", "z-index:100",
      "background:rgba(0,0,0,0.7)", "color:#00ff99",
      "font-family:monospace", "font-size:11px", "line-height:1.7",
      "padding:6px 12px", "border-radius:6px",
      "border:1px solid rgba(0,255,153,0.25)",
      "pointer-events:none", "user-select:none",
    ].join(";");
    this.view.contentEl.style.position = "relative";
    this.view.contentEl.appendChild(overlay);
    this._devOverlay = overlay;
    this._devLastTime = performance.now();
  }

  private _destroyDevOverlay() {
    this._devOverlay?.remove();
    this._devOverlay = null;
  }

  private _createAuroraButton() {
    if (this._auroraButton) return;
    const btn = document.createElement("div");
    btn.style.cssText = [
      "position:absolute", "top:8px", "right:48px", "z-index:100",
      "background:rgba(0,0,0,0.65)", "color:#b0c4ff",
      "font-family:monospace", "font-size:11px",
      "padding:5px 10px", "border-radius:6px",
      "border:1px solid rgba(176,196,255,0.25)",
      "cursor:pointer", "user-select:none",
      "transition:background 0.15s",
    ].join(";");
    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(0,0,0,0.85)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(0,0,0,0.65)";
    });
    btn.addEventListener("click", () => {
      const settingManager = this.view.settingManager;
      const cur = settingManager.getCurrentSetting().display.auroraEnabled;
      settingManager.updateCurrentSettings((s) => {
        s.value.display.auroraEnabled = !cur;
      });
      // refresh cached link colors / particles immediately
      this.interactionManager.updateColor();
    });
    this.view.contentEl.style.position = "relative";
    this.view.contentEl.appendChild(btn);
    this._auroraButton = btn;
    this._syncAuroraButton();
  }

  private _syncAuroraButton() {
    if (!this._auroraButton) return;
    const enabled = this.view.settingManager.getCurrentSetting().display.auroraEnabled;
    if (enabled === this._lastAuroraState) return;
    this._lastAuroraState = enabled;
    this._auroraButton.textContent = enabled ? "✦ Aurora ON" : "✦ Aurora OFF";
    this._auroraButton.style.color = enabled ? "#00e8a0" : "#666";
    this._auroraButton.style.borderColor = enabled
      ? "rgba(0,232,160,0.35)"
      : "rgba(120,120,120,0.3)";
  }

  private _destroyAuroraButton() {
    this._auroraButton?.remove();
    this._auroraButton = null;
    this._lastAuroraState = null;
  }

  private _updateDevOverlayContent() {
    if (!this._devOverlay) return;
    const totalNodes = this.instance.graphData().nodes.length;
    const culled = this._devLabelCulled;
    const total = this._devLabelTotal;
    const visible = total - culled;
    const stellium = this.view.settingManager.getCurrentSetting().display.stelliumMode;
    const instanced = this._instancedMesh
      ? `✓ ${totalNodes} instances / 1 draw call`
      : stellium
        ? `✗ (star nodes mode uses sprites)`
        : totalNodes === 0
          ? `✗ (no nodes)`
          : `✗ (building...)`;
    this._devOverlay.innerHTML =
      `FPS: <b>${this._devFps}</b><br>` +
      `Total nodes: ${totalNodes}<br>` +
      `Labels visible: ${visible} / ${total}<br>` +
      `Labels culled: ${culled}<br>` +
      `GPU instancing: ${instanced}`;
  }

  /**
   * update the dimensions of the graph
   */
  public updateDimensions(dimension?: [number, number]) {
    if (dimension) this.instance.width(dimension[0]).height(dimension[1]);
    else {
      const rootHtmlElement = this.view.contentEl as HTMLDivElement;
      const [width, height] = [rootHtmlElement.offsetWidth, rootHtmlElement.offsetHeight];
      this.instance.width(width).height(height);
    }
  }

  public updateConfig(config: DeepPartial<LocalGraphSettings | GlobalGraphSettings>) {
    const { error } = syncOf(() => this.updateInstance(undefined, config));
    if (error) {
      console.error(error);
    }
  }

  /**
   * given a new force Graph, the update the graph and the instance
   */
  public updateGraph(graph: Graph) {
    // some optimization here
    // if the graph is the same, then we don't need to update the graph
    const same = Graph.compare(this.instance.graphData(), graph);
    if (!same) {
      const { error } = syncOf(() => this.updateInstance(graph, undefined));
      if (error) {
        console.error(error);
      }
    } else console.log("same graph, no need to update");
  }

  /**
   * given the changed things, update the instance
   */
  private updateInstance = (
    graph?: Graph,
    config?: DeepPartial<LocalGraphSettings | GlobalGraphSettings>
  ) => {
    if (graph !== undefined) this.instance.graphData(graph);
    if (config?.display?.backgroundColor !== undefined)
      this.instance.backgroundColor(hexToRGBA(config.display.backgroundColor, 1));
    if (config?.display?.nodeSize !== undefined)
      this.instance.nodeRelSize(config.display?.nodeSize);
    if (config?.display?.linkDistance !== undefined) {
      this.instance.d3Force("link")?.distance(config.display?.linkDistance);
    }
    if (config?.display?.nodeRepulsion !== undefined) {
      this.instance.d3Force("charge")?.strength(-config.display?.nodeRepulsion);
      this.instance
        .d3Force("x", d3.forceX(0).strength(1 - config.display?.nodeRepulsion / 3000 + 0.001))
        .d3Force("y", d3.forceY(0).strength(1 - config.display?.nodeRepulsion / 3000 + 0.001))
        .d3Force("z", d3.forceZ(0).strength(1 - config.display?.nodeRepulsion / 3000 + 0.001));
    }
    if (config?.display?.showCenterCoordinates !== undefined) {
      this.centerCoordinates.setVisibility(config.display.showCenterCoordinates);
    }

    if ((config as LocalGraphSettings)?.display?.dagOrientation !== undefined) {
      let dagOrientation = config?.display?.dagOrientation ?? DagOrientation.null;
      // check if graph is async or not
      if (
        !this.instance.graphData().isAcyclic() &&
        this.view.settingManager.getCurrentSetting().display.dagOrientation !== DagOrientation.null
      ) {
        createNotice("The graph is cyclic, dag orientation will be ignored");
        dagOrientation = DagOrientation.null;
      }

      const noDag = dagOrientation === DagOrientation.null;
      // @ts-ignore
      this.instance.dagMode(noDag ? null : config?.display.dagOrientation).dagLevelDistance(75);
    }

    /**
     * derive the need to reheat the simulation
     */
    const needReheat =
      config?.display?.nodeRepulsion !== undefined ||
      config?.display?.linkDistance !== undefined ||
      (config as LocalGraphSettings)?.display?.dagOrientation !== undefined;

    if (needReheat) {
      this.instance.numDimensions(3); // reheat simulation
      this.instance.refresh();
    }
  };
}
