import type { ForceGraph3DInstance } from "3d-force-graph";
import ForceGraph3D from "3d-force-graph";
import { Graph } from "@/graph/Graph";
import { CenterCoordinates } from "@/views/graph/CenterCoordinates";
import * as THREE from "three";
import * as d3 from "d3-force-3d";
import { hexToRGBA } from "@/util/hexToRGBA";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { FOCAL_FROM_CAMERA, ForceGraphEngine } from "@/views/graph/ForceGraphEngine";
import type { DeepPartial } from "ts-essentials";
import type { Node } from "@/graph/Node";
import { createStarSprite, type StarSpriteHandle } from "@/stellium/StarSprite";

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
      .linkDirectionalArrowLength(this.interactionManager.getLinkDirectionalArrowLength)
      .linkDirectionalArrowRelPos(1)
      // ── Trace animation: animated line overlay on threads-mode links ──────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .linkThreeObject((_link: any) => {
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
        return new THREE.Line(geo, mat);
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .linkPositionUpdate((obj: any, coords: any, link: any) => {
        const TRACE_SEGS = 32;
        const settings = this.view.settingManager.getCurrentSetting();
        const line = obj as THREE.Line;

        if (settings.display.linkStyle !== "threads") {
          line.visible = false;
          return false;
        }

        line.visible = true;
        const geo = line.geometry;
        const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
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

        const mat = line.material as THREE.LineBasicMaterial;
        const isHighlighted = this.interactionManager.highlightedLinks.has(link);
        const isAurora = this.interactionManager.isAuroraLink(link);

        if (isAurora) {
          const phase = (((link.__tracePhase as number) ?? Math.random()) + 0.018) % 1;
          link.__tracePhase = phase;
          const segCount = Math.floor(0.45 * (TRACE_SEGS + 1));
          const segStart = Math.min(
            Math.floor(phase * (TRACE_SEGS + 1)),
            TRACE_SEGS + 1 - segCount
          );
          geo.setDrawRange(segStart, segCount);
          mat.color.set(settings.display.auroraColor1 ?? "#00e8a0");
          mat.opacity = Math.max(0.35, settings.display.auroraIntensity ?? 0.6);
        } else if (isHighlighted) {
          let p: number = (link.__traceP as number) ?? 0;
          p = Math.min(p + 0.1, 1);
          link.__traceP = p;
          geo.setDrawRange(0, Math.ceil(p * (TRACE_SEGS + 1)));
          mat.color.set(0xffffff);
          mat.opacity = 0.9;
        } else {
          let p: number = (link.__traceP as number) ?? 0;
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

    // P3: build instanced mesh before nodeThreeObject runs (non-stellium mode only)
    const initSettings = this.view.settingManager.getCurrentSetting();
    if (!initSettings.display.stelliumMode) {
      this._buildInstancedMesh(graph, scene);
    }

    // Dev overlay
    if (initSettings.display.devMode) {
      this._createDevOverlay();
    }

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
          const value = 1 - this.interactionManager.getNodeOpacityEasedValue(node);
          const opacity =
            this.interactionManager.getIsAnyHighlighted() &&
            !this.interactionManager.isHighlightedNode(node)
              ? Math.clamp(value, 0, 0.2)
              : this.interactionManager.hoveredNode === node
              ? 1
              : value;

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
        };
        const directColor   = d.nodeHoverColor ?? "#ff6633";
        const neighborColor = d.nodeHoverNeighbourColor ?? "#00ff00";
        const cullDist = d.labelCullDistance ?? 800;
        const camPos = (camera as THREE.PerspectiveCamera).position;
        // skip aurora canvas redraw on odd frames (keeps animation smooth, halves GPU uploads)
        const skipDraw = this._globalFrame % 2 === 1;

        this.starSprites.forEach((handle, path) => {
          const node = this.instance.graphData().getNodeByPath(path);
          if (!node) return;

          // LOD: hide sprites beyond cull distance and skip all updates
          const dist = camPos.distanceTo(handle.sprite.position);
          if (dist > cullDist) {
            handle.sprite.visible = false;
            return;
          }
          handle.sprite.visible = true;

          const isDirect   = this.interactionManager.hoveredNode === node;
          const isNeighbor = !isDirect && this.interactionManager.isHighlightedNode(node);
          // never skip draw for hovered nodes — their aurora must stay perfectly in sync
          handle.update(
            this.interactionManager.isAuroraNode(node),
            colors,
            isDirect || isNeighbor,
            isDirect ? directColor : neighborColor,
            skipDraw && !isDirect,
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
    if (this._instancedMesh) {
      this.instance.scene().remove(this._instancedMesh);
      this._instancedMesh.geometry.dispose();
      (this._instancedMesh.material as THREE.Material).dispose();
      this._instancedMesh = null;
      this._nodeInstanceIndex.clear();
    }
    this._destroyDevOverlay();
  }

  private _buildInstancedMesh(graph: Graph, scene: THREE.Scene) {
    const count = graph.nodes.length;
    if (count === 0) return;
    const geo = new THREE.SphereGeometry(1, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ opacity: 0.9, transparent: true });
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
      config?.display?.linkThickness !== undefined ||
      (config as LocalGraphSettings)?.display?.dagOrientation !== undefined;

    if (needReheat) {
      this.instance.numDimensions(3); // reheat simulation
      this.instance.refresh();
    }
  };
}
