import { addSimpleSliderSetting } from "@/views/atomics/addSimpleSliderSetting";
import { addColorPickerSetting } from "@/views/atomics/addColorPickerSetting";
import { addToggle } from "@/views/atomics/addToggle";
import { DropdownComponent, Setting } from "obsidian";
import type {
  GlobalGraphSettings,
  LocalDisplaySettings,
  LocalGraphSettings,
} from "@/SettingsSchemas";
import {
  DagOrientation,
  distanceFromFocal,
  labelCullDistance,
  linkDistance,
  nodeRepulsion,
  nodeSize,
  threadOpacity,
  traceDurationMs,
  sparkSize,
  starSizeMultiplier,
  auroraSizeMultiplier,
  auroraIntensity,
  auroraIntensityFocused,
  fogFar,
  bloomStrength,
  bloomThreshold,
  dofFocusZone,
  dofMaxBlur,
} from "@/SettingsSchemas";
import type { BaseGraphSettingManager } from "@/views/settings/graphSettingManagers/GraphSettingsManager";
import type { State } from "@/util/State";
import { createNotice } from "@/util/createNotice";

export const DisplaySettingsView = (
  graphSetting: GlobalGraphSettings | LocalGraphSettings,
  containerEl: HTMLElement,
  settingManager: BaseGraphSettingManager
) => {
  const displaySettings = graphSetting.display;
  // add the node size setting
  addSimpleSliderSetting(
    containerEl,
    {
      name: "Node size",
      value: displaySettings.nodeSize,
      stepOptions: nodeSize,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.nodeSize = value;
      });
    }
  );

  // add link distance settings
  addSimpleSliderSetting(
    containerEl,
    {
      name: "Link distance",
      value: displaySettings.linkDistance,
      stepOptions: linkDistance,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.linkDistance = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Node repulsion",
      value: displaySettings.nodeRepulsion,
      stepOptions: nodeRepulsion,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.nodeRepulsion = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Distance from focal",
      value: displaySettings.distanceFromFocal,
      stepOptions: distanceFromFocal,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.distanceFromFocal = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Label visibility distance",
      value: displaySettings.labelCullDistance ?? labelCullDistance.default,
      stepOptions: labelCullDistance,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.labelCullDistance = value;
      });
    }
  );

  addToggle(
    containerEl,
    {
      name: "Dev mode",
      description: "Show FPS, node count, and label culling stats overlay.",
      value: displaySettings.devMode ?? false,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.devMode = value;
      });
    }
  );

  addColorPickerSetting(
    containerEl,
    {
      name: "Node hover color",
      value: displaySettings.nodeHoverColor,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.nodeHoverColor = value;
      });
    }
  );

  // add node hover color setting
  addColorPickerSetting(
    containerEl,
    {
      name: "Node hover neighbour color",
      value: displaySettings.nodeHoverNeighbourColor,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.nodeHoverNeighbourColor = value;
      });
    }
  );

  addColorPickerSetting(
    containerEl,
    {
      name: "Selected node color",
      value: displaySettings.selectedNodeColor ?? "#ffd700",
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.selectedNodeColor = value;
      });
    }
  );

  // add show extension setting
  addToggle(
    containerEl,
    {
      name: "Show file extension",
      value: displaySettings.showExtension,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.showExtension = value;
      });
    }
  );

  // add show full path setting
  addToggle(
    containerEl,
    {
      name: "Show note full path",
      value: displaySettings.showFullPath,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.showFullPath = value;
      });
    }
  );

  addToggle(
    containerEl,
    {
      name: "Show center coordinates",
      value: displaySettings.showCenterCoordinates,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.showCenterCoordinates = value;
      });
    }
  );

  addToggle(
    containerEl,
    {
      name: "Don't move when drag",
      value: displaySettings.dontMoveWhenDrag,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.dontMoveWhenDrag = value;
      });
    }
  );

  const localDisplaySettings = displaySettings as LocalDisplaySettings;
  const dagDropDown = new Setting(containerEl).setName("Dag orientation");

  const dropdown = new DropdownComponent(dagDropDown.settingEl)
    .addOptions(DagOrientation)
    // the default value will be null
    .setValue(localDisplaySettings.dagOrientation ?? DagOrientation.null)
    .onChange(async (value) => {
      settingManager.updateCurrentSettings((setting: State<LocalGraphSettings>) => {
        if (
          !settingManager.getGraphView().getForceGraph().instance.graphData().isAcyclic() &&
          value !== DagOrientation.null
        ) {
          createNotice("The graph is cyclic, dag orientation will be ignored");
        } else {
          setting.value.display.dagOrientation = value as LocalDisplaySettings["dagOrientation"];
        }
      });
    });

  // if (
  //   settingManager.getGraphView().graphType === GraphType.global ||
  //   (graphSetting as LocalGraphSettings).filter.linkType === "both"
  // ) {
  //   // hide the dag orientation setting
  //   dagDropDown.settingEl.hide();
  // }

  const hideDagOrientationSetting = () => {
    // if the link type is both, then we need to hide the dag orientation setting
    dagDropDown.settingEl.hide();
    // set the dag orientation to null
    settingManager.updateCurrentSettings((setting: State<LocalGraphSettings>) => {
      setting.value.display.dagOrientation = DagOrientation.null;
    });

    // set the UI as well
    dropdown.setValue(DagOrientation.null);
  };

  const showDagOrientationSetting = () => {
    // if the link type is either inlink or outlink, then we need to add the dag orientation setting
    dagDropDown.settingEl.show();
    // set the dag orientation to null
    settingManager.updateCurrentSettings((setting: State<LocalGraphSettings>) => {
      setting.value.display.dagOrientation = DagOrientation.null;
    });

    // set the UI as well
    dropdown.setValue(DagOrientation.null);
  };

  const isDropdownHidden = () => {
    return dagDropDown.settingEl.style.display === "none";
  };

  // ── Stellium visual settings ────────────────────────────────────────────────
  new Setting(containerEl).setName("✦ Stellium").setHeading();

  // Background
  addColorPickerSetting(
    containerEl,
    { name: "Background color", value: displaySettings.backgroundColor ?? "#000000" },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.backgroundColor = value;
      });
    }
  );

  // Star nodes toggle
  addToggle(
    containerEl,
    {
      name: "Star nodes",
      description: "Replace spheres with star sprites. Brighter = more connections.",
      value: displaySettings.stelliumMode,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.stelliumMode = value;
      });
      settingManager.getGraphView().refreshGraph();
    }
  );

  // Star colors & size
  addColorPickerSetting(
    containerEl,
    { name: "Star core color", value: displaySettings.starCoreColor ?? "#ffffff" },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.starCoreColor = value;
      });
    }
  );

  addColorPickerSetting(
    containerEl,
    { name: "Star halo color", value: displaySettings.starHaloColor ?? "#b0c4ff" },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.starHaloColor = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    { name: "Star size", value: displaySettings.starSizeMultiplier ?? 1.0, stepOptions: starSizeMultiplier },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.starSizeMultiplier = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    { name: "Thread opacity", value: displaySettings.threadOpacity ?? 0.22, stepOptions: threadOpacity },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.threadOpacity = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Trace duration (ms)",
      value: displaySettings.traceDurationMs ?? 500,
      stepOptions: traceDurationMs,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.traceDurationMs = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Spark size",
      value: displaySettings.sparkSize ?? 1.0,
      stepOptions: sparkSize,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.sparkSize = value;
      });
    }
  );

  addToggle(
    containerEl,
    {
      name: "Show link particles",
      description: "Flowing particles on hovered links.",
      value: displaySettings.showLinkParticles ?? true,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.showLinkParticles = value;
      });
    }
  );

  // Aurora section
  addToggle(
    containerEl,
    {
      name: "Aurora borealis on RAG nodes",
      description: "Nodes visited by rag query glow with aurora colours.",
      value: displaySettings.auroraEnabled,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraEnabled = value;
      });
    }
  );

  addColorPickerSetting(
    containerEl,
    { name: "Aurora color 1 (inner)", value: displaySettings.auroraColor1 ?? "#00e8a0" },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraColor1 = value;
      });
    }
  );

  addColorPickerSetting(
    containerEl,
    { name: "Aurora color 2 (mid)", value: displaySettings.auroraColor2 ?? "#b040ff" },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraColor2 = value;
      });
    }
  );

  addColorPickerSetting(
    containerEl,
    { name: "Aurora color 3 (outer)", value: displaySettings.auroraColor3 ?? "#00c8d0" },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraColor3 = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    { name: "Aurora size", value: displaySettings.auroraSizeMultiplier ?? 1.8, stepOptions: auroraSizeMultiplier },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraSizeMultiplier = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    { name: "Aurora intensity", value: displaySettings.auroraIntensity ?? 0.6, stepOptions: auroraIntensity },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraIntensity = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Aurora intensity (when focusing)",
      value: displaySettings.auroraIntensityFocused ?? 0.15,
      stepOptions: auroraIntensityFocused,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraIntensityFocused = value;
      });
    }
  );

  addToggle(
    containerEl,
    {
      name: "Aurora halo",
      description: "Outer corona around aurora stars. Off = cleaner look (only inner glow stays).",
      value: displaySettings.auroraHaloEnabled ?? false,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.auroraHaloEnabled = value;
      });
    }
  );

  // ── Visual effects ──────────────────────────────────────────────────────────
  new Setting(containerEl).setName("✦ Effects").setHeading();

  addToggle(
    containerEl,
    {
      name: "Fog",
      description: "Distant stars fade into the background. Free.",
      value: displaySettings.fogEnabled ?? true,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.fogEnabled = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Fog distance",
      value: displaySettings.fogFar ?? 1500,
      stepOptions: fogFar,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.fogFar = value;
      });
    }
  );

  addToggle(
    containerEl,
    {
      name: "Bloom (glow on bright stars)",
      description: "Real glow around aurora cores. Costs ~3-5ms/frame on integrated GPUs.",
      value: displaySettings.bloomEnabled ?? true,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.bloomEnabled = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    { name: "Bloom strength", value: displaySettings.bloomStrength ?? 0.6, stepOptions: bloomStrength },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.bloomStrength = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "Bloom threshold",
      description: "Higher = only the brightest pixels glow.",
      value: displaySettings.bloomThreshold ?? 0.7,
      stepOptions: bloomThreshold,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.bloomThreshold = value;
      });
    }
  );

  addToggle(
    containerEl,
    {
      name: "Depth of field",
      description: "Blurs distant stars cinematically. Costs +5-10ms/frame.",
      value: displaySettings.dofEnabled ?? false,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.dofEnabled = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "DoF sharp padding",
      description: "Extra world-units of clarity past the closest visible star. The sharp sphere is sized as (distance to nearest star) + this value, so something always stays in focus. Blur ramps to its maximum over this same distance again.",
      value: displaySettings.dofFocusZone ?? 500,
      stepOptions: dofFocusZone,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.dofFocusZone = value;
      });
    }
  );

  addSimpleSliderSetting(
    containerEl,
    {
      name: "DoF max blur",
      description: "Strongest blur applied past the focus radius (fraction of screen size). 0.01 ≈ subtle, 0.03 = heavy haze.",
      value: displaySettings.dofMaxBlur ?? 0.01,
      stepOptions: dofMaxBlur,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.dofMaxBlur = value;
      });
    }
  );

  return {
    hideDagOrientationSetting,
    showDagOrientationSetting,
    isDropdownHidden,
  };
};
