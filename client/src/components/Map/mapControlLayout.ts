export type MapControlLayoutMode = 'wide' | 'compact' | 'stacked';

export interface MapControlLayoutInput {
  viewportWidth: number;
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  hasPoi: boolean;
  hasCompass: boolean;
}

export interface MapControlLayout {
  mode: MapControlLayoutMode;
  centerX: number;
  top: number;
  direction: 'row' | 'column';
  controlsWidth: number;
  safeLeft: number;
  safeRight: number;
  availableWidth: number;
}

const PANEL_MARGIN = 10;
const PANEL_TOGGLE_SIZE = 44;
const PANEL_TOGGLE_OVERHANG = 36;
const CONTROL_SAFE_GAP = 12;
const CONTROL_GAP = 8;
const WIDE_POI_WIDTH = 294;
const COMPACT_POI_WIDTH = 44;
const WIDE_COMPASS_WIDTH = 42;
const COMPACT_COMPASS_WIDTH = 44;
const TOP_OFFSET = 14;
const STACKED_TOP_OFFSET = 76;

function combinedWidth(first: number, second: number): number {
  return first + second + (first > 0 && second > 0 ? CONTROL_GAP : 0);
}

export function getMapControlLayout({
  viewportWidth,
  leftWidth,
  rightWidth,
  leftCollapsed,
  rightCollapsed,
  hasPoi,
  hasCompass,
}: MapControlLayoutInput): MapControlLayout {
  const leftOccupied = leftCollapsed
    ? PANEL_MARGIN + PANEL_TOGGLE_SIZE
    : PANEL_MARGIN + leftWidth + PANEL_TOGGLE_OVERHANG;
  const rightOccupied = rightCollapsed
    ? PANEL_MARGIN + PANEL_TOGGLE_SIZE
    : PANEL_MARGIN + rightWidth + PANEL_TOGGLE_OVERHANG;
  const safeLeft = leftOccupied + CONTROL_SAFE_GAP;
  const safeRight = viewportWidth - rightOccupied - CONTROL_SAFE_GAP;
  const availableWidth = Math.max(0, safeRight - safeLeft);
  const centerX = (safeLeft + safeRight) / 2;

  const wideCompassWidth = hasCompass ? WIDE_COMPASS_WIDTH : 0;
  const compactCompassWidth = hasCompass ? COMPACT_COMPASS_WIDTH : 0;
  const wideWidth = combinedWidth(hasPoi ? WIDE_POI_WIDTH : 0, wideCompassWidth);
  const compactWidth = combinedWidth(hasPoi ? COMPACT_POI_WIDTH : 0, compactCompassWidth);

  if (hasPoi && wideWidth <= availableWidth) {
    return {
      mode: 'wide',
      centerX,
      top: TOP_OFFSET,
      direction: 'row',
      controlsWidth: wideWidth,
      safeLeft,
      safeRight,
      availableWidth,
    };
  }

  if (compactWidth <= availableWidth) {
    return {
      mode: 'compact',
      centerX,
      top: TOP_OFFSET,
      direction: 'row',
      controlsWidth: compactWidth,
      safeLeft,
      safeRight,
      availableWidth,
    };
  }

  return {
    mode: 'stacked',
    centerX,
    top: STACKED_TOP_OFFSET,
    direction: 'column',
    controlsWidth: Math.max(hasPoi ? COMPACT_POI_WIDTH : 0, compactCompassWidth),
    safeLeft,
    safeRight,
    availableWidth,
  };
}
