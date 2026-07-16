import { AlertTriangle, RotateCw, Search, X } from 'lucide-react';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from '../../i18n';
import { Tooltip } from '../shared/Tooltip';
import { POI_CATEGORIES, type PoiCategory } from './poiCategories';

interface Props {
  active: Set<string>;
  onToggle: (key: string) => void;
  loadingKeys?: Set<string>;
  /** categories whose last fetch failed → show a retry affordance */
  errorKeys?: Set<string>;
  /** true when the map moved since the last search → offer "search this area" */
  moved?: boolean;
  onSearchArea?: () => void;
  /** collapse the eight-category row into one touch-sized popover trigger */
  compact?: boolean;
}

interface CategoryButtonProps {
  cat: PoiCategory;
  label: string;
  on: boolean;
  loading: boolean;
  error: boolean;
  onToggle: () => void;
  labelled?: boolean;
  onMouseEnter?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
}

const CategoryButton = React.forwardRef<HTMLButtonElement, CategoryButtonProps>(function CategoryButton(
  { cat, label, on, loading, error, onToggle, labelled = false, onMouseEnter, onMouseLeave, onFocus, onBlur },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-busy={loading || undefined}
      aria-label={label}
      className={on ? '' : 'text-content-muted'}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: labelled ? 'flex-start' : 'center',
        gap: labelled ? 9 : 0,
        width: labelled ? '100%' : 34,
        height: labelled ? 44 : 34,
        minWidth: labelled ? 0 : 34,
        padding: labelled ? '6px 10px' : 0,
        borderRadius: labelled ? 12 : 999,
        border: labelled ? '1px solid var(--border-faint)' : 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: labelled ? (on ? `${cat.color}18` : 'var(--bg-secondary)') : on ? cat.color : 'transparent',
        color: labelled ? (on ? cat.color : undefined) : on ? '#fff' : undefined,
        transition: 'background 0.14s, color 0.14s, border-color 0.14s',
      }}
      onMouseEnter={(e) => {
        if (!on) e.currentTarget.style.background = 'var(--bg-hover)';
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (!on) e.currentTarget.style.background = labelled ? 'var(--bg-secondary)' : 'transparent';
        onMouseLeave?.(e);
      }}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <span
        style={{
          position: 'relative',
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: labelled ? 30 : 16,
          height: labelled ? 30 : 16,
          borderRadius: 999,
          background: labelled && on ? cat.color : 'transparent',
          color: labelled && on ? '#fff' : undefined,
        }}
      >
        {loading ? (
          <span
            className="animate-spin"
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              display: 'inline-block',
              border: '2px solid',
              borderColor: on ? 'rgba(255,255,255,0.45)' : 'var(--border-primary)',
              borderTopColor: on ? '#fff' : 'var(--text-muted)',
            }}
          />
        ) : (
          <cat.Icon size={16} strokeWidth={2} />
        )}
        {on && !loading && error && (
          <span
            style={{
              position: 'absolute',
              top: labelled ? -2 : -6,
              right: labelled ? -2 : -6,
              width: 8,
              height: 8,
              borderRadius: 999,
              background: '#ef4444',
              border: '1.5px solid var(--sidebar-bg)',
            }}
          />
        )}
      </span>
      {labelled && (
        <span
          className="text-content"
          style={{
            minWidth: 0,
            fontSize: 'calc(12px * var(--fs-scale-body, 1))',
            fontWeight: on ? 600 : 500,
            lineHeight: 1.2,
            textAlign: 'left',
          }}
        >
          {label}
        </span>
      )}
    </button>
  );
});

// Frosted, icon-only segmented control that floats over the map. Active segments
// fill with the category colour (matching their markers); the label shows in a
// custom tooltip on hover so the pill stays compact and never needs to scroll.
export default function PoiCategoryPill({
  active,
  onToggle,
  loadingKeys,
  errorKeys,
  moved,
  onSearchArea,
  compact = false,
}: Props) {
  const { t } = useTranslation();
  const anyError = !!errorKeys && Array.from(active).some((k) => errorKeys.has(k));
  const anyLoading = !!loadingKeys && Array.from(active).some((k) => loadingKeys.has(k));
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const firstCategoryRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const exploreLabel = t('settings.mapPoiPill');
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 12, width: 304 });

  const frosted: React.CSSProperties = {
    background: 'var(--sidebar-bg)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    boxShadow: 'var(--sidebar-shadow, 0 4px 16px rgba(0,0,0,0.14))',
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const edge = 12;
      const width = Math.min(304, Math.max(240, window.innerWidth - edge * 2));
      const left = Math.max(edge, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - edge));
      setPopoverPosition({ top: rect.bottom + 8, left, width });
    };
    position();
    firstCategoryRef.current?.focus();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
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

  useEffect(() => {
    if (!compact) setOpen(false);
  }, [compact]);

  if (compact) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          aria-label={exploreLabel}
          aria-haspopup="dialog"
          aria-controls={popoverId}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="text-content"
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            padding: 0,
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            pointerEvents: 'auto',
            touchAction: 'manipulation',
            fontFamily: 'inherit',
            ...frosted,
          }}
        >
          {anyLoading ? (
            <span
              className="animate-spin"
              style={{
                width: 17,
                height: 17,
                borderRadius: 999,
                border: '2px solid var(--border-primary)',
                borderTopColor: 'var(--text-primary)',
              }}
            />
          ) : (
            <Search size={18} strokeWidth={2.2} />
          )}
          {active.size > 0 && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: -3,
                right: -3,
                minWidth: 17,
                height: 17,
                padding: '0 4px',
                borderRadius: 999,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: anyError ? '#ef4444' : 'var(--accent)',
                color: anyError ? '#fff' : 'var(--accent-text)',
                border: '2px solid var(--sidebar-bg)',
                fontSize: 9,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {active.size}
            </span>
          )}
        </button>

        {open &&
          ReactDOM.createPortal(
            <div
              ref={popoverRef}
              id={popoverId}
              role="dialog"
              aria-label={exploreLabel}
              data-columns="2"
              className="trek-popover-enter border border-edge-faint bg-surface-card text-content"
              style={{
                position: 'fixed',
                top: popoverPosition.top,
                left: popoverPosition.left,
                width: popoverPosition.width,
                zIndex: 100000,
                padding: 10,
                borderRadius: 18,
                pointerEvents: 'auto',
                boxShadow: '0 16px 40px rgba(0,0,0,0.2)',
                backdropFilter: 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                fontFamily: 'var(--font-system)',
              }}
            >
              <div
                style={{
                  minHeight: 36,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '0 0 6px 8px',
                }}
              >
                <span style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 650 }}>
                  {exploreLabel}
                </span>
                <button
                  type="button"
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className="text-content-muted"
                  style={{
                    width: 44,
                    height: 44,
                    margin: -4,
                    borderRadius: 999,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <X size={17} />
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                {POI_CATEGORIES.map((cat, index) => (
                  <CategoryButton
                    key={cat.key}
                    cat={cat}
                    label={t(cat.labelKey)}
                    on={active.has(cat.key)}
                    loading={!!loadingKeys?.has(cat.key)}
                    error={!!errorKeys?.has(cat.key)}
                    onToggle={() => onToggle(cat.key)}
                    labelled
                    ref={index === 0 ? firstCategoryRef : undefined}
                  />
                ))}
              </div>

              {(moved || anyError) && active.size > 0 && (
                <button
                  type="button"
                  onClick={onSearchArea}
                  className="text-content"
                  style={{
                    width: '100%',
                    minHeight: 44,
                    marginTop: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                    padding: '8px 13px',
                    borderRadius: 12,
                    border: '1px solid var(--border-faint)',
                    cursor: 'pointer',
                    background: 'var(--bg-secondary)',
                    color: anyError ? '#ef4444' : undefined,
                    fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                    fontWeight: 600,
                    fontFamily: 'inherit',
                  }}
                >
                  {anyError ? <AlertTriangle size={14} strokeWidth={2.4} /> : <RotateCw size={14} strokeWidth={2.4} />}
                  {t('poi.searchThisArea')}
                </button>
              )}
            </div>,
            document.body
          )}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          padding: 4,
          borderRadius: 999,
          pointerEvents: 'auto',
          ...frosted,
        }}
      >
        {POI_CATEGORIES.map((cat) => {
          const on = active.has(cat.key);
          return (
            <Tooltip key={cat.key} label={t(cat.labelKey)} placement="bottom">
              <CategoryButton
                cat={cat}
                label={t(cat.labelKey)}
                on={on}
                loading={!!loadingKeys?.has(cat.key)}
                error={!!errorKeys?.has(cat.key)}
                onToggle={() => onToggle(cat.key)}
              />
            </Tooltip>
          );
        })}
      </div>

      {(moved || anyError) && active.size > 0 && (
        <button
          type="button"
          onClick={onSearchArea}
          className="text-content"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 13px',
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            pointerEvents: 'auto',
            color: anyError ? '#ef4444' : undefined,
            ...frosted,
          }}
        >
          {anyError ? <AlertTriangle size={13} strokeWidth={2.4} /> : <RotateCw size={13} strokeWidth={2.4} />}
          {t('poi.searchThisArea')}
        </button>
      )}
    </div>
  );
}
