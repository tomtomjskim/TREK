import { describe, expect, it } from 'vitest';
import { getMapControlLayout } from './mapControlLayout';

const DEFAULT_PANELS = {
  leftWidth: 340,
  rightWidth: 300,
  leftCollapsed: false,
  rightCollapsed: false,
  hasPoi: true,
  hasCompass: true,
};

describe('getMapControlLayout', () => {
  it.each([
    { viewportWidth: 768, mode: 'stacked', centerX: 404, availableWidth: 12 },
    { viewportWidth: 800, mode: 'stacked', centerX: 420, availableWidth: 44 },
    { viewportWidth: 884, mode: 'compact', centerX: 462, availableWidth: 128 },
    { viewportWidth: 1024, mode: 'compact', centerX: 532, availableWidth: 268 },
    { viewportWidth: 1280, mode: 'wide', centerX: 660, availableWidth: 524 },
  ] as const)(
    'selects $mode controls at $viewportWidth px with default panels',
    ({ viewportWidth, mode, centerX, availableWidth }) => {
      const layout = getMapControlLayout({ viewportWidth, ...DEFAULT_PANELS });

      expect(layout.mode).toBe(mode);
      expect(layout.centerX).toBe(centerX);
      expect(layout.availableWidth).toBe(availableWidth);
    }
  );

  it('centres wide controls in the free corridor when one panel is collapsed', () => {
    const layout = getMapControlLayout({
      viewportWidth: 884,
      ...DEFAULT_PANELS,
      leftCollapsed: true,
    });

    expect(layout).toMatchObject({
      mode: 'wide',
      safeLeft: 66,
      safeRight: 526,
      centerX: 296,
      availableWidth: 460,
    });
  });

  it('keeps compact controls inside the corridor with maximum-width panels', () => {
    const layout = getMapControlLayout({
      viewportWidth: 1280,
      ...DEFAULT_PANELS,
      leftWidth: 520,
      rightWidth: 520,
    });

    expect(layout).toMatchObject({
      mode: 'compact',
      safeLeft: 578,
      safeRight: 702,
      centerX: 640,
      controlsWidth: 96,
    });
    expect(layout.centerX - layout.controlsWidth / 2).toBeGreaterThanOrEqual(layout.safeLeft);
    expect(layout.centerX + layout.controlsWidth / 2).toBeLessThanOrEqual(layout.safeRight);
  });

  it('uses the below-toggle stacked fallback when persisted panels leave no corridor', () => {
    const layout = getMapControlLayout({
      viewportWidth: 1024,
      ...DEFAULT_PANELS,
      leftWidth: 520,
      rightWidth: 520,
    });

    expect(layout.mode).toBe('stacked');
    expect(layout.direction).toBe('column');
    expect(layout.top).toBeGreaterThanOrEqual(76);
  });

  it('does not reserve width for controls that are disabled or unavailable', () => {
    const poiOnly = getMapControlLayout({
      viewportWidth: 800,
      ...DEFAULT_PANELS,
      hasCompass: false,
    });
    const compassOnly = getMapControlLayout({
      viewportWidth: 800,
      ...DEFAULT_PANELS,
      hasPoi: false,
    });

    expect(poiOnly).toMatchObject({ mode: 'compact', controlsWidth: 44 });
    expect(compassOnly).toMatchObject({ mode: 'compact', controlsWidth: 44 });
  });
});
