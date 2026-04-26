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
  linkDistance,
  linkThickness,
  nodeRepulsion,
  nodeSize,
  threadOpacity,
  starSizeMultiplier,
  auroraSizeMultiplier,
  auroraIntensity,
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

  // add link thinkness setting
  addSimpleSliderSetting(
    containerEl,
    {
      name: "Link thickness",
      value: displaySettings.linkThickness,
      stepOptions: linkThickness,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.linkThickness = value;
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

  // add link hover color setting
  addColorPickerSetting(
    containerEl,
    {
      name: "Link hover color",
      value: displaySettings.linkHoverColor,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.linkHoverColor = value;
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
      name: "Show link arrow",
      value: displaySettings.showLinkArrow,
    },
    (value) => {
      settingManager.updateCurrentSettings((setting) => {
        setting.value.display.showLinkArrow = value;
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

  // Link style
  new Setting(containerEl)
    .setName("Link style")
    .setDesc("Threads: thin white filaments inspired by constellations.")
    .addDropdown((dd) =>
      dd
        .addOption("default", "Default")
        .addOption("threads", "Threads (white filaments)")
        .setValue(displaySettings.linkStyle ?? "default")
        .onChange((value) => {
          settingManager.updateCurrentSettings((setting) => {
            setting.value.display.linkStyle = value as "default" | "threads";
          });
        })
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

  return {
    hideDagOrientationSetting,
    showDagOrientationSetting,
    isDropdownHidden,
  };
};
