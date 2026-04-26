import type Graph3dPlugin from "@/main";

const HIGHLIGHT_PATH = "_meta/stellium_highlight.json";

interface HighlightPayload {
  timestamp: string;
  nodes: string[];  // vault paths, e.g. "entities/Machine Learning.md"
  links: [string, string][];
}

export class StelliumWatcher {
  public auroraNodes: Set<string> = new Set();
  public auroraLinks: Set<string> = new Set();

  constructor(private plugin: Graph3dPlugin) {
    // Watch for file modifications
    plugin.registerEvent(
      plugin.app.vault.on("modify", (file) => {
        if (file.path === HIGHLIGHT_PATH) this.loadHighlight();
      })
    );
    // Also fire on create in case the file didn't exist yet when plugin loaded
    plugin.registerEvent(
      plugin.app.vault.on("create", (file) => {
        if (file.path === HIGHLIGHT_PATH) this.loadHighlight();
      })
    );
    // Load whatever is already on disk
    this.loadHighlight();
  }

  private async loadHighlight(): Promise<void> {
    try {
      const raw = await this.plugin.app.vault.adapter.read(HIGHLIGHT_PATH);
      const data = JSON.parse(raw) as HighlightPayload;
      this.auroraNodes = new Set(data.nodes ?? []);
      this.auroraLinks = new Set(
        (data.links ?? []).map(([a, b]) => `${a}\x00${b}`)
      );
      // Notify all active graph views to refresh colours
      this.plugin.activeGraphViews.forEach((view) => {
        view.getForceGraph()?.interactionManager.onAuroraUpdate();
      });
    } catch {
      // File may not exist yet — silently ignore
    }
  }

  public clear(): void {
    this.auroraNodes.clear();
    this.auroraLinks.clear();
    this.plugin.activeGraphViews.forEach((view) => {
      view.getForceGraph()?.interactionManager.onAuroraUpdate();
    });
  }
}
