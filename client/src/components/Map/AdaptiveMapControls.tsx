import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { MapCompassPill, type CompassMap } from './MapCompassPill';
import PoiCategoryPill from './PoiCategoryPill';
import { POI_CATEGORIES } from './poiCategories';
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

type PoiControls = Omit<React.ComponentProps<typeof PoiCategoryPill>, 'compact'>;

function CompactPoiControl({ poi }: { poi: PoiControls }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const firstCategoryRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const [position, setPosition] = useState({ top: 0, left: 12, width: 304 });
  const label = t('settings.mapPoiPill');
  const anyLoading = !!poi.loadingKeys && Array.from(poi.active).some(key => poi.loadingKeys?.has(key));

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const edge = 12;
      const width = Math.min(304, Math.max(240, window.innerWidth - edge * 2));
      const left = Math.max(edge, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - edge));
      setPosition({ top: rect.bottom + 8, left, width });
    };
    update();
    firstCategoryRef.current?.focus();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const frosted: React.CSSProperties = {
    background: 'var(--sidebar-bg)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    boxShadow: 'var(--sidebar-shadow, 0 4px 16px rgba(0,0,0,0.14))',
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="text-content"
        style={{ width: 44, height: 44, padding: 0, border: 'none', borderRadius: 999, cursor: 'pointer', pointerEvents: 'auto', touchAction: 'manipulation', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative', ...frosted }}
      >
        {anyLoading ? <span className="animate-spin" style={{ width: 17, height: 17, borderRadius: 999, border: '2px solid var(--border-primary)', borderTopColor: 'var(--text-primary)' }} /> : <Search size={18} strokeWidth={2.2} />}
        {poi.active.size > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: -3, right: -3, minWidth: 17, height: 17, padding: '0 4px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: poi.errorKeys && Array.from(poi.active).some(key => poi.errorKeys?.has(key)) ? '#ef4444' : 'var(--accent)', color: 'var(--accent-text)', border: '2px solid var(--sidebar-bg)', fontSize: 9, fontWeight: 700, lineHeight: 1 }}>{poi.active.size}</span>}
      </button>
      {open && createPortal(
        <div ref={popoverRef} id={popoverId} role="dialog" aria-label={label} data-columns="2" className="border border-edge-faint bg-surface-card text-content" style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, zIndex: 100000, padding: 10, borderRadius: 18, pointerEvents: 'auto', boxShadow: '0 16px 40px rgba(0,0,0,0.2)', fontFamily: 'var(--font-system)' }}>
          <div style={{ minHeight: 36, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 0 6px 8px' }}>
            <span style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 650 }}>{label}</span>
            <button type="button" aria-label={t('common.close')} title={t('common.close')} onClick={() => { setOpen(false); triggerRef.current?.focus() }} style={{ width: 44, height: 44, margin: -4, border: 'none', borderRadius: 999, background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X size={17} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
            {POI_CATEGORIES.map((category, index) => {
              const active = poi.active.has(category.key);
              return <button key={category.key} ref={index === 0 ? firstCategoryRef : undefined} type="button" aria-label={t(category.labelKey)} aria-pressed={active} onClick={() => poi.onToggle(category.key)} style={{ minWidth: 0, minHeight: 44, padding: '6px 10px', borderRadius: 12, border: '1px solid var(--border-faint)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 9, background: active ? `${category.color}18` : 'var(--bg-secondary)', color: active ? category.color : undefined, fontFamily: 'inherit' }}><span style={{ width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, background: active ? category.color : 'transparent', color: active ? '#fff' : undefined }}><category.Icon size={16} strokeWidth={2} /></span><span style={{ minWidth: 0, fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: active ? 600 : 500, textAlign: 'left' }}>{t(category.labelKey)}</span></button>;
            })}
          </div>
          {(poi.moved || Array.from(poi.active).some(key => poi.errorKeys?.has(key))) && poi.active.size > 0 && <button type="button" onClick={poi.onSearchArea} style={{ width: '100%', minHeight: 44, marginTop: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, border: '1px solid var(--border-faint)', cursor: 'pointer', background: 'var(--bg-secondary)', fontFamily: 'inherit' }}>{t('poi.searchThisArea')}</button>}
        </div>,
        document.body,
      )}
    </>
  );
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
      {poiEnabled && (compact ? <CompactPoiControl poi={poi} /> : <PoiCategoryPill {...poi} />)}
      {map && <MapCompassPill map={map} compact={compact} />}
    </div>
  );
}
