import * as TWEEN from "@tweenjs/tween.js";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import type { Node } from "@/graph/Node";
import type { BaseForceGraph } from "@/views/graph/ForceGraph";
import type { Link } from "@/graph/Link";
import { createNotice } from "@/util/createNotice";
import { hexToRGBA } from "@/util/hexToRGBA";
import type { TFile } from "obsidian";

const origin = new THREE.Vector3(0, 0, 0);
const cameraLookAtCenterTransitionDuration = 1000;
export const FOCAL_FROM_CAMERA = 400;

/**
 * this instance handle all the interaction. In other words, the interaction manager
 */
export class ForceGraphEngine {
  private forceGraph: BaseForceGraph;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tween: { [tweenId: string]: TWEEN.Tween<any> | undefined } = {};
  private spaceDown = false;
  private commandDown = false;
  private selectedNodes = new Set<Node>();
  /**
   * Nodes currently revealed in the focus animation (the focus node + emitter
   * sources whose traces are originating from them). Outgoing destinations
   * are NOT here until their incoming trace finishes and onTraceArrived fires.
   */
  public readonly highlightedNodes: Set<string> = new Set();
  /**
   * the links connected to the hover node
   */
  public readonly highlightedLinks: Set<Link> = new Set();
  /**
   * Outgoing destinations awaiting trace arrival before they reveal.
   */
  public readonly pendingDestinations: Set<string> = new Set();
  /**
   * Node id → start time (ms) for an active arrival pulse. Read by the
   * star-sprite tick to scale the sprite briefly when an incoming trace lands.
   */
  public readonly pulseTriggers: Map<string, number> = new Map();
  hoveredNode: Node | null = null;

  // zooming
  private isZooming = false;
  private startZoomTimeout: Timer | undefined;
  private endZoomTimeout: Timer | undefined;

  // bound references so they can be removed in destroy()
  private boundKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceDown = true;
    if (e.metaKey) this.commandDown = true;
  };
  private boundKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceDown = false;
    if (!e.metaKey) this.commandDown = false;
  };

  constructor(forceGraph: BaseForceGraph) {
    this.forceGraph = forceGraph;
    this.initListeners();
  }

  public destroy() {
    document.removeEventListener("keydown", this.boundKeyDown);
    document.removeEventListener("keyup", this.boundKeyUp);
    clearTimeout(this.startZoomTimeout);
    clearTimeout(this.endZoomTimeout);
  }

  onZoom(event: WheelEvent) {
    const camera = this.forceGraph.instance.camera() as THREE.PerspectiveCamera;
    // check if it is start zooming using setTimeout
    // if it is, then cancel the animation
    if (!this.isZooming && !this.startZoomTimeout) {
      this.startZoomTimeout = setTimeout(() => {
        // console.log("this should only show once");
        if (!this.isZooming) {
          clearTimeout(this.startZoomTimeout);
          this.startZoomTimeout = undefined;
          this.isZooming = true;
          this.onZoomStart();
        }
        return;
      }, 100);
    }

    const distanceToCenter = camera.position.distanceTo(origin);
    camera.updateProjectionMatrix();
    this.forceGraph.centerCoordinates.setLength(distanceToCenter / 10);

    if (this.isZooming) {
      clearTimeout(this.endZoomTimeout);
      this.endZoomTimeout = setTimeout(() => {
        this.endZoomTimeout = undefined;
        this.isZooming = false;
        this.onZoomEnd();
      }, 100);
    }
  }

  private onZoomEnd() {}

  private onZoomStart = () => {
    const tweens = Object.keys(this.tween);
    if (tweens) {
      Object.values(this.tween).forEach((tween) => {
        if (tween) {
          tween.stop();
        }
      });
      // remove the tween
      this.tween = {};
    }
  };

  onNodeDrag = (node: Node & Coords, translate: Coords) => {
    // https://github.com/vasturiano/3d-force-graph/issues/279#issuecomment-587135032
    if (this.forceGraph.view.settingManager.getCurrentSetting().display.dontMoveWhenDrag)
      this.forceGraph.instance.cooldownTicks(0);
    if (this.selectedNodes.has(node)) {
      // moving a selected node
      [...this.selectedNodes]
        .filter((selNode) => selNode !== node) // don't touch node being dragged
        .forEach((node) =>
          ["x", "y", "z"].forEach(
            // @ts-ignore
            (coord) => (node[`f${coord}`] = node[coord] + translate[coord])
          )
        ); // translate other nodes by same amount
    }
  };

  onNodeDragEnd = (node: Node & Coords) => {
    const setting = this.forceGraph.view.settingManager.getCurrentSetting();
    // https://github.com/vasturiano/3d-force-graph/issues/279#issuecomment-587135032
    if (setting.display.dontMoveWhenDrag) this.forceGraph.instance.cooldownTicks(Infinity);
    if (this.selectedNodes.has(node)) {
      // finished moving a selected node
      [...this.selectedNodes]
        .filter((selNode) => selNode !== node) // don't touch node being dragged
        // @ts-ignore
        .forEach((node) => ["x", "y", "z"].forEach((coord) => (node[`f${coord}`] = undefined))); // unfix controlled nodes
    }
  };

  // Right click semantics:
  //  - on a pinned node → unpin only it (keeps others)
  //  - on an unpinned node → replace selection with just it (or add if shift)
  onNodeRightClick = (node: Node & Coords, event: MouseEvent) => {
    if (this.selectedNodes.has(node)) {
      this.selectedNodes.delete(node);
    } else {
      if (!event.shiftKey) this.selectedNodes.clear();
      this.selectedNodes.add(node);
    }
    this.rebuildHighlights();
    this.updateColor();
  };

  // Track double-click manually (3d-force-graph fires onNodeClick on every click; we delay to detect dbl)
  private _lastClickNodeId: string | null = null;
  private _lastClickTime = 0;
  private _pendingClickTimer: Timer | undefined;

  onNodeClick = (node: Node & Coords, event: MouseEvent) => {
    // Shift+left → multi-select (kept for power users)
    if (event.shiftKey) {
      const isSelected = this.selectedNodes.has(node);
      isSelected ? this.selectedNodes.delete(node) : this.selectedNodes.add(node);
      this.rebuildHighlights();
      this.updateColor();
      return;
    }

    const now = performance.now();
    const isDouble =
      this._lastClickNodeId === node.id && now - this._lastClickTime < 300;

    if (isDouble) {
      // Double left click → open in new tab
      clearTimeout(this._pendingClickTimer);
      this._pendingClickTimer = undefined;
      this._lastClickNodeId = null;
      const file = this.findFileByNode(node);
      if (file) this.openFileInNewTab(file);
      return;
    }

    // Single left click → focus camera (constellation view) + pin the node
    this._lastClickNodeId = node.id;
    this._lastClickTime = now;
    clearTimeout(this._pendingClickTimer);
    this._pendingClickTimer = setTimeout(() => {
      this._pendingClickTimer = undefined;
      this._lastClickNodeId = null;
      this.focusOnConstellation(node);
      if (!this.selectedNodes.has(node)) {
        this.selectedNodes.add(node);
        this.rebuildHighlights();
        this.updateColor();
      }
    }, 300);
  };

  onNodeHover = (node: Node | null) => {
    if ((!node && !this.hoveredNode) || (node && this.hoveredNode === node)) return;

    // set node label text
    if (node) {
      const text = this.getNodeLabelText(node);
      this.forceGraph.nodeLabelEl.textContent = text;
      // @ts-ignore
      this.forceGraph.nodeLabelEl.style.color = node.color;
      this.forceGraph.nodeLabelEl.style.opacity = "1";
    } else {
      this.forceGraph.nodeLabelEl.style.opacity = "0";
    }

    this.hoveredNode = node ?? null;
    this.rebuildHighlights();

    const shouldUseCommand =
      this.forceGraph.view.plugin.app.internalPlugins.getPluginById("page-preview").instance
        .overrides["3d-graph"] !== false;
    // show the hover preview
    if (node && node.labelEl && ((shouldUseCommand && this.commandDown) || !shouldUseCommand)) {
      this.forceGraph.view.hoverPopover?.hide();
      this.forceGraph.view.eventBus.trigger("open-node-preview", node);
      this.forceGraph.view.eventBus.trigger("open-node-preview", node);
    }

    this.updateColor();
  };

  private clearHighlights = () => {
    this.highlightedLinks.forEach((l) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (l as any).__traceArrived = false;
    });
    this.highlightedNodes.clear();
    this.highlightedLinks.clear();
    this.pendingDestinations.clear();
  };

  /**
   * Rebuilds the focus animation state. Emitter sources (incoming neighbours
   * of the focus node + the focus node itself) are revealed at t=0; outgoing
   * destinations are queued in pendingDestinations and only revealed once
   * their incoming trace reaches them (see onTraceArrived).
   */
  public rebuildHighlights = () => {
    // Reset arrival flags on previously highlighted links so they re-animate cleanly
    this.highlightedLinks.forEach((l) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (l as any).__traceArrived = false;
    });
    this.highlightedNodes.clear();
    this.highlightedLinks.clear();
    this.pendingDestinations.clear();

    const focusNodes: Node[] = [];
    if (this.hoveredNode) focusNodes.push(this.hoveredNode);
    this.selectedNodes.forEach((n) => focusNodes.push(n));
    if (focusNodes.length === 0) return;

    const focusIds = new Set(focusNodes.map((n) => n.id));

    focusNodes.forEach((n) => {
      this.highlightedNodes.add(n.id);
      const links = this.forceGraph.instance.graphData().getLinksWithNode(n.id);
      if (!links) return;
      links.forEach((l) => {
        this.highlightedLinks.add(l);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (l as any).__traceP = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (l as any).__traceArrived = false;

        if (l.target.id === n.id) {
          // Incoming: source emits, focus pulses on arrival → emitter lights immediately
          if (!focusIds.has(l.source.id)) this.highlightedNodes.add(l.source.id);
        } else {
          // Outgoing: focus emits → destination waits for trace arrival
          if (!focusIds.has(l.target.id)) this.pendingDestinations.add(l.target.id);
        }
      });
    });

    // A node that's both an emitter (lit) and a pending destination stays lit.
    this.highlightedNodes.forEach((id) => this.pendingDestinations.delete(id));
  };

  /**
   * Called by linkPositionUpdate the frame a highlighted link's trace
   * progress crosses 1. Reveals the destination (outgoing) or fires a pulse
   * on the focus node (incoming). Idempotent via link.__traceArrived.
   */
  public onTraceArrived = (link: Link) => {
    const focusIds = new Set<string>();
    if (this.hoveredNode) focusIds.add(this.hoveredNode.id);
    this.selectedNodes.forEach((n) => focusIds.add(n.id));
    if (focusIds.size === 0) return;

    let mutated = false;
    if (focusIds.has(link.source.id) && !focusIds.has(link.target.id)) {
      if (this.pendingDestinations.delete(link.target.id)) {
        this.highlightedNodes.add(link.target.id);
        mutated = true;
      }
    }
    if (focusIds.has(link.target.id)) {
      this.pulseTriggers.set(link.target.id, performance.now());
    }
    if (mutated) this.updateColor();
  };

  updateNodeLabelDiv() {
    this.forceGraph.instance.nodeThreeObject(this.forceGraph.instance.nodeThreeObject());
  }

  /**
   * this will update the color of the nodes and links
   */
  updateColor() {
    // trigger update of highlighted objects in scene
    this.forceGraph.instance
      .nodeColor(this.forceGraph.instance.nodeColor())
      .linkColor(this.forceGraph.instance.linkColor())
      .linkDirectionalParticles(this.forceGraph.instance.linkDirectionalParticles());
  }

  getLinkColor = (link: Link) => {
    const settings = this.forceGraph.view.settingManager.getCurrentSetting();
    const focusActive = this.getIsAnyHighlighted();
    const isHighlighted = this.isHighlightedLink(link);
    const isAurora = this.isAuroraLink(link);
    const op = settings.display.threadOpacity ?? 0.22;
    if (isAurora) {
      const auroraAlpha =
        focusActive && !isHighlighted
          ? Math.min(op * 0.4, 0.12)
          : Math.min(op * 2.5, 0.85);
      return hexToRGBA(settings.display.auroraColor1 ?? "#00e8a0", auroraAlpha);
    }
    if (isHighlighted) return `rgba(255,255,255,${Math.min(op * 4, 0.95)})`;
    return focusActive
      ? `rgba(255,255,255,${(op * 0.3).toFixed(3)})`
      : `rgba(255,255,255,${op.toFixed(3)})`;
  };

  getLinkWidth = (link: Link) => {
    if (this.isAuroraLink(link)) return 1.4;
    return this.isHighlightedLink(link) ? 0.8 : 0.3;
  };

  getLinkDirectionalParticles = (link: Link) => {
    const settings = this.forceGraph.view.settingManager.getCurrentSetting();
    if (!settings.display.showLinkParticles) return 0;
    if (!this.isHighlightedLink(link)) return 0;
    return 10;
  };

  getLinkDirectionalParticleWidth = () => 2.5;

  getLinkDirectionalParticleSpeed = (link: Link) => {
    return this.isHighlightedLink(link) ? 0.004 : 0.01;
  };

  getLinkDirectionalParticleColor = (link: Link) => {
    const settings = this.forceGraph.view.settingManager.getCurrentSetting();
    if (this.isAuroraLink(link))
      return hexToRGBA(settings.display.auroraColor1 ?? "#00e8a0", 0.95);
    return hexToRGBA(settings.display.nodeHoverNeighbourColor ?? "#00ff00", 0.8);
  };

  onLinkHover = (link: Link | null) => {
    this.clearHighlights();

    if (link) {
      this.highlightedLinks.add(link);
      this.highlightedNodes.add(link.source.id);
      this.highlightedNodes.add(link.target.id);
    }
    this.updateColor();
  };

  findFileByNode = (node: Node): TFile | undefined => {
    return this.forceGraph.view.plugin.app.vault.getFiles().find((f) => f.path === node.path);
  };

  public getNodeOpacityEasedValue = (node: Node) => {
    // get the position of the node
    // @ts-ignore
    const obj = node.__threeObj as THREE.Object3D | undefined;
    if (!obj) return 0;
    const nodePosition = obj.position;
    // then get the distance between the node and this.myCube , console.log it
    const distance = nodePosition.distanceTo(this.forceGraph.myCube.position);
    // change the opacity of the nodeEl base on the distance
    // the higher the distance, the lower the opacity
    // when the distance is 300, the opacity is 0
    const distanceFromFocal =
      this.forceGraph.view.settingManager.getCurrentSetting().display.distanceFromFocal;
    const normalizedDistance = Math.min(distance, distanceFromFocal) / distanceFromFocal;
    const easedValue = 0.5 - 0.5 * Math.cos(normalizedDistance * Math.PI);
    return easedValue;
  };

  private isHighlightedLink = (link: Link): boolean => {
    return this.highlightedLinks.has(link);
  };

  public isAuroraNode = (node: Node): boolean => {
    const settings = this.forceGraph.view.settingManager.getCurrentSetting();
    if (!settings.display.auroraEnabled) return false;
    return this.forceGraph.view.plugin.stelliumWatcher?.auroraNodes.has(node.path) ?? false;
  };

  public isAuroraLink = (link: Link): boolean => {
    const settings = this.forceGraph.view.settingManager.getCurrentSetting();
    if (!settings.display.auroraEnabled) return false;
    const watcher = this.forceGraph.view.plugin.stelliumWatcher;
    if (!watcher) return false;
    return watcher.auroraNodes.has(link.source.path) && watcher.auroraNodes.has(link.target.path);
  };

  /** Called by StelliumWatcher when the highlight file changes. */
  public onAuroraUpdate(): void {
    // The animation loop switches sprites to aurora canvas automatically on next frame.
    // Just refresh link/node colors so aurora links get their colour immediately.
    this.updateColor();
  }

  public getNodeLabelText = (node: Node) => {
    const settings = this.forceGraph.view.settingManager.getCurrentSetting();
    const fullPath = node.path;
    const fileNameWithExtension = node.name;
    const fullPathWithoutExtension = fullPath.substring(0, fullPath.lastIndexOf("."));
    const fileNameWithoutExtension = fileNameWithExtension.substring(
      0,
      fileNameWithExtension.lastIndexOf(".")
    );
    const text = !settings.display.showExtension
      ? settings.display.showFullPath
        ? fullPathWithoutExtension
        : fileNameWithoutExtension
      : settings.display.showFullPath
      ? fullPath
      : fileNameWithExtension;
    return text;
  };

  initListeners() {
    document.addEventListener("keydown", this.boundKeyDown);
    document.addEventListener("keyup", this.boundKeyUp);
  }

  /**
   *
   * if the input is undefined, return the current camera position. else this will move the camera to a specific position.
   */
  public cameraPosition(
    position: Partial<Coords> | undefined,
    lookAt: Coords | undefined,
    transitionDuration: number | undefined
  ) {
    const instance = this.forceGraph.instance;
    const camera = instance.camera();
    const controls = instance.controls() as OrbitControls;
    const tween = this.tween;
    if (position === undefined && lookAt === undefined && transitionDuration === undefined) {
      return {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      };
    }

    if (position) {
      const finalPos = position;
      const finalLookAt = lookAt || { x: 0, y: 0, z: 0 };

      if (!transitionDuration) {
        // no animation

        setCameraPos(finalPos);
        setLookAt(finalLookAt);
      } else {
        const camPos = Object.assign({}, camera.position);
        const camLookAt = getLookAt();

        // create unique id for position tween
        const posTweenId = Math.random().toString(36).substring(2, 15);

        tween[posTweenId] = new TWEEN.Tween(camPos)
          .to(finalPos, transitionDuration)
          .easing(TWEEN.Easing.Quadratic.Out)
          .onUpdate(setCameraPos)
          .onComplete(() => {
            tween[posTweenId] = undefined;
          })
          .start();

        // create unique id for lookAt tween
        const lookAtTweenId = Math.random().toString(36).substring(2, 15);

        // Face direction in 1/3rd of time
        tween[lookAtTweenId] = new TWEEN.Tween(camLookAt)
          .to(finalLookAt, transitionDuration / 3)
          .easing(TWEEN.Easing.Quadratic.Out)
          .onUpdate(setLookAt)
          .onComplete(() => {
            tween[lookAtTweenId] = undefined;
          })
          .start();
      }

      // eslint-disable-next-line no-inner-declarations
      function setCameraPos(pos: Partial<Coords>) {
        const { x, y, z } = pos;
        if (x !== undefined) camera.position.x = x;
        if (y !== undefined) camera.position.y = y;
        if (z !== undefined) camera.position.z = z;
      }

      // eslint-disable-next-line no-inner-declarations
      function setLookAt(lookAt: Coords) {
        const lookAtVect = new THREE.Vector3(lookAt.x, lookAt.y, lookAt.z);
        if (controls.target) {
          controls.target = lookAtVect;
        } else {
          // Fly controls doesn't have target attribute
          camera.lookAt(lookAtVect); // note: lookAt may be overridden by other controls in some cases
        }
      }

      // eslint-disable-next-line no-inner-declarations
      function getLookAt() {
        return Object.assign(
          new THREE.Vector3(0, 0, -1000).applyQuaternion(camera.quaternion).add(camera.position)
        );
      }
    }
  }

  /**
   * this will force the camera to look at a specific position
   * @param lookAt
   * @param transitionDuration
   */
  public cameraLookAt(lookAt: Coords, transitionDuration: number | undefined) {
    this.cameraPosition(undefined, lookAt, transitionDuration);
  }

  /**
   * this will force the camera to look at the center of the graph
   */
  public cameraLookAtCenter = () => {
    const cameraPosition = this.forceGraph.instance.camera().position;
    this.cameraPosition(cameraPosition, { x: 0, y: 0, z: 0 }, cameraLookAtCenterTransitionDuration);
  };

  public focusOnNodeByPath = (path: string) => {
    // TODO: test if this is right
    const node = (this.forceGraph.instance.graphData().nodes as (Node & Coords)[]).find(
      (n) => n.path === path
    );
    if (node) {
      this.focusOnCoords(node, 1000);
    }
  };

  public focusOnCoords = (coords: Coords, duration = 3000) => {
    // Aim at node from outside it
    const distance = FOCAL_FROM_CAMERA;
    const distRatio = 1 + distance / Math.hypot(coords.x, coords.y, coords.z);

    const newPos =
      coords.x || coords.y || coords.z
        ? { x: coords.x * distRatio, y: coords.y * distRatio, z: coords.z * distRatio }
        : { x: 0, y: 0, z: distance }; // special case if node is in (0,0,0)

    this.cameraPosition(
      newPos, // new position
      coords, // lookAt ({ x, y, z })
      duration // ms transition duration
    );
  };

  /**
   * Constellation view ("vista cenital de pirámide"):
   *  - clicked node = pyramid apex
   *  - neighbours = pyramid base
   *  - axis = (apex - base_centroid)
   * Camera is placed past the apex along this axis, looking back at the apex.
   * Result: apex is centred, neighbours fan out radially behind it.
   */
  public focusOnConstellation = (node: Node & Coords, duration = 1500) => {
    const camera = this.forceGraph.instance.camera() as THREE.PerspectiveCamera;

    // Compute neighbour centroid + max distance (constellation radius)
    let cx = 0, cy = 0, cz = 0, count = 0;
    let radius = 60;
    for (const nb of node.neighbors ?? []) {
      const c = nb as unknown as Partial<Coords>;
      if (typeof c.x === "number" && typeof c.y === "number" && typeof c.z === "number") {
        cx += c.x; cy += c.y; cz += c.z; count++;
        const d = Math.hypot(c.x - node.x, c.y - node.y, c.z - node.z);
        if (d > radius) radius = d;
      }
    }

    // Pyramid axis: from base centroid toward apex (clicked node)
    let viewDir: THREE.Vector3;
    if (count > 0) {
      cx /= count; cy /= count; cz /= count;
      viewDir = new THREE.Vector3(node.x - cx, node.y - cy, node.z - cz);
      // Degenerate case: apex coincides with centroid → fall back to current camera dir
      if (viewDir.lengthSq() < 1e-6) {
        camera.getWorldDirection(viewDir);
        viewDir.negate(); // we want camera-to-apex direction (opposite of view)
      }
      viewDir.normalize();
    } else {
      // No neighbours → keep current orientation
      viewDir = new THREE.Vector3();
      camera.getWorldDirection(viewDir);
      viewDir.negate();
    }

    // Camera distance to fit constellation radius in FOV (with padding)
    const fovRad = (camera.fov * Math.PI) / 180;
    const camDistance = (radius * 1.6) / Math.tan(fovRad / 2);

    // Place camera past the apex along the pyramid axis, looking at the apex
    const newPos = {
      x: node.x + viewDir.x * camDistance,
      y: node.y + viewDir.y * camDistance,
      z: node.z + viewDir.z * camDistance,
    };

    this.cameraPosition(newPos, { x: node.x, y: node.y, z: node.z }, duration);
  };

  public isHighlightedNode = (node: Node): boolean => {
    return this.highlightedNodes.has(node.id);
  };

  public getNodeColor = (node: Node): string => {
    let color: string;
    const settings = this.forceGraph.view.settingManager.getCurrentSetting();
    const theme = this.forceGraph.view.theme;
    const searchResult = this.forceGraph.view.settingManager.searchResult;
    if (this.selectedNodes.has(node)) {
      color = settings.display.selectedNodeColor ?? "#ffd700";
    } else if (this.isHighlightedNode(node)) {
      color =
        node === this.hoveredNode
          ? settings.display.nodeHoverColor
          : settings.display.nodeHoverNeighbourColor;
    } else {
      color = theme.graphNode;
      settings.groups.forEach((group, index) => {
        if (group.query.trim().length === 0) return;
        const searchStateGroup = searchResult.value.groups[index];
        if (searchStateGroup) {
          const searchGroupfilePaths = searchStateGroup.files.map((file) => file.path);

          // if the node path is in the searchGroupfiles, change the color to group.color
          if (searchGroupfilePaths.includes(node.path)) color = group.color;
        }
      });
    }
    const rgba = hexToRGBA(
      color,
      this.getIsAnyHighlighted() && !this.isHighlightedNode(node) ? 0.5 : 1
    );
    return rgba;
  };

  public getIsAnyHighlighted = () => {
    return this.highlightedNodes.size !== 0 || this.highlightedLinks.size !== 0;
  };

  public removeSelection() {
    this.selectedNodes.clear();
    this.rebuildHighlights();
    this.updateColor();
  }

  public searchNode(path: string) {
    const targetNode = this.forceGraph.instance.graphData().getNodeByPath(path);
    if (targetNode) this.focusOnCoords(targetNode as Node & Coords);
    else createNotice("The node doesn't exist in the graph");
  }

  public openFileInNewTab(file: TFile) {
    this.forceGraph.view.plugin.app.workspace.getLeaf(false).openFile(file);
  }
}
