import React, { useEffect, useState } from 'react';
import { MapCompassPill, type CompassMap } from './MapCompassPill';
import PoiCategoryPill from './PoiCategoryPill';
import { getMapControlLayout } from './mapControlLayout';

interface AdaptiveMapControlsProps {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  poiEnabled: boolean;
  poi: Omit<React.ComponentProps<typeof PoiCategoryPill>, 'compact'>;
  map: CompassMap | null;
}

export default function AdaptiveMapControls({
  leftWidth,
  rightWidth,
  leftCollapsed,
  rightCollapsed,
  poiEnabled,
  poi,
  map,
}: AdaptiveMapControlsProps) {
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  if (!poiEnabled && !map) return null;

  const layout = getMapControlLayout({
    viewportWidth,
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    hasPoi: poiEnabled,
    hasCompass: Boolean(map),
  });
  const compact = layout.mode !== 'wide';

  return (
    <div
      data-testid="adaptive-map-controls"
      data-layout-mode={layout.mode}
      data-safe-left={layout.safeLeft}
      data-safe-right={layout.safeRight}
      data-controls-width={layout.controlsWidth}
      className="hidden md:flex"
      style={{
        position: 'absolute',
        top: layout.top,
        left: layout.centerX,
        transform: 'translateX(-50%)',
        zIndex: 19,
        pointerEvents: 'none',
        flexDirection: layout.direction,
        alignItems: layout.direction === 'column' ? 'center' : 'flex-start',
        gap: 8,
        transition: 'left 180ms cubic-bezier(0.23,1,0.32,1), top 180ms cubic-bezier(0.23,1,0.32,1)',
      }}
    >
      {poiEnabled && <PoiCategoryPill {...poi} compact={compact} />}
      {map && <MapCompassPill map={map} compact={compact} />}
    </div>
  );
}
