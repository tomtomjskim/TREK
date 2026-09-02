import React, { useState, useRef, useEffect, useContext, useId } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { useAnchoredPosition, scrollAnchorIntoView } from '../../hooks/useAnchoredPosition'
import { ModalFocusScopeContext } from './Modal'

interface SelectOption {
  // Callers use both string keys and numeric ids (e.g. day/place ids) as values;
  // the component only does strict-equality lookups and key rendering, so either works.
  value: string | number
  label: string
  icon?: React.ReactNode
  isHeader?: boolean
  searchLabel?: string
  groupLabel?: string
  badge?: string
  disabled?: boolean
}

interface CustomSelectProps {
  value: string | number
  onChange: (value: string | number) => void
  options?: SelectOption[]
  placeholder?: string
  searchable?: boolean
  style?: React.CSSProperties
  size?: 'sm' | 'md'
  disabled?: boolean
}

export default function CustomSelect({
  value,
  onChange,
  options = [],
  placeholder = '',
  searchable = false,
  style = {},
  size = 'md',
  disabled = false,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeValue, setActiveValue] = useState<string | number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const modalFocusScopeId = useContext(ModalFocusScopeContext)
  const listboxId = `custom-select-${useId().replace(/:/g, '')}`

  // Follows the trigger while the sheet scrolls and while the on-screen keyboard
  // resizes the viewport, instead of freezing at the rect measured on open (#1999).
  const anchored = useAnchoredPosition(ref, open)

  useEffect(() => {
    if (!open || !searchable || !searchRef.current) return
    searchRef.current.focus()
    // Focusing raises the keyboard on a phone; scroll the trigger up so the list
    // it just opened is not left underneath it (#2000).
    scrollAnchorIntoView(ref.current)
  }, [open, searchable])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      if (dropRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selected = options.find(o => o.value === value)
  const filtered = searchable && search
    ? (() => {
        const q = search.toLowerCase()
        const result: SelectOption[] = []
        let currentHeader: SelectOption | null = null
        let headerAdded = false
        for (const o of options) {
          if (o.isHeader) {
            currentHeader = o
            headerAdded = false
            continue
          }
          const haystack = [o.label, o.searchLabel, o.groupLabel].filter(Boolean).join(' ').toLowerCase()
          if (haystack.includes(q)) {
            if (currentHeader && !headerAdded) {
              result.push(currentHeader)
              headerAdded = true
            }
            result.push(o)
          }
        }
        return result
      })()
    : options

  const sm = size === 'sm'
  const selectable = filtered.filter(option => !option.isHeader && !option.disabled)
  const resolvedActiveValue = selectable.some(option => option.value === activeValue)
    ? activeValue
    : (selectable.find(option => option.value === value)?.value ?? selectable[0]?.value ?? null)

  useEffect(() => {
    if (open && activeValue !== resolvedActiveValue) setActiveValue(resolvedActiveValue)
  }, [activeValue, open, resolvedActiveValue])

  const openSelect = () => {
    if (disabled) return
    setOpen(true)
    setSearch('')
    setActiveValue(selected && !selected.isHeader && !selected.disabled ? selected.value : (selectable[0]?.value ?? null))
  }

  const closeSelect = () => {
    setOpen(false)
    setSearch('')
    triggerRef.current?.focus()
  }

  const selectValue = (nextValue: string | number) => {
    onChange(nextValue)
    closeSelect()
  }

  const moveActive = (direction: 1 | -1) => {
    if (selectable.length === 0) return
    const currentIndex = selectable.findIndex(option => option.value === resolvedActiveValue)
    const nextIndex = currentIndex < 0
      ? (direction === 1 ? 0 : selectable.length - 1)
      : (currentIndex + direction + selectable.length) % selectable.length
    setActiveValue(selectable[nextIndex].value)
  }

  const handleKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openSelect()
      }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (selectable.length > 0) setActiveValue((event.key === 'Home' ? selectable[0] : selectable[selectable.length - 1]).value)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const active = selectable.find(option => option.value === resolvedActiveValue)
      if (active) selectValue(active.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSelect()
    }
  }

  const handleSearchKeyboard = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Space and Home/End are ordinary text editing keys while searching.
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== 'Escape' && event.key !== ' ' && event.key !== 'Home' && event.key !== 'End') return
    event.stopPropagation()
    if (event.key !== ' ' && event.key !== 'Home' && event.key !== 'End') handleKeyboard(event)
  }

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && resolvedActiveValue !== null ? `${listboxId}-option-${String(resolvedActiveValue)}` : undefined}
        onKeyDown={handleKeyboard}
        onClick={() => { if (!disabled) { if (open) closeSelect(); else openSelect() } }}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: sm ? '8px 12px' : '8px 14px', borderRadius: 10,
          border: '1px solid var(--border-primary)',
          background: 'var(--bg-input)', color: 'var(--text-primary)',
          fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500, fontFamily: 'inherit',
          cursor: disabled ? 'default' : 'pointer', outline: 'none', textAlign: 'left',
          transition: 'border-color 0.15s', overflow: 'hidden', minWidth: 0,
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--text-faint)' }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.borderColor = 'var(--border-primary)' }}
      >
        {selected?.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{selected.icon}</span>}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--text-primary)' : 'var(--text-faint)' }}>
          {selected ? selected.label : placeholder}
        </span>
        {selected?.badge && (
          <span style={{
            flexShrink: 0, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600, color: 'var(--text-muted)',
            background: 'var(--bg-tertiary)', padding: '2px 7px', borderRadius: 999,
            letterSpacing: '0.01em',
          }}>{selected.badge}</span>
        )}
        <ChevronDown size={sm ? 12 : 14} style={{ flexShrink: 0, color: 'var(--text-faint)', transition: 'transform 200ms cubic-bezier(0.23,1,0.32,1)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      {/* Dropdown */}
      {open && createPortal(
        <div
          ref={dropRef}
          id={listboxId}
          role="listbox"
          aria-label={placeholder || 'Options'}
          aria-activedescendant={resolvedActiveValue !== null ? `${listboxId}-option-${String(resolvedActiveValue)}` : undefined}
          onKeyDown={handleKeyboard}
          data-trek-modal-focus-scope={modalFocusScopeId ?? undefined}
          style={{
            position: 'fixed',
            ...(anchored
              ? anchored.flipped
                ? { bottom: anchored.bottom, left: anchored.left, width: anchored.width }
                : { top: anchored.top, left: anchored.left, width: anchored.width }
              : { top: 0, left: 0, width: 200 }),
            zIndex: 99999,
            background: 'var(--bg-card)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            border: '1px solid var(--border-primary)',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
            overflow: 'hidden',
            animation: 'trek-menu-enter 200ms cubic-bezier(0.23, 1, 0.32, 1)',
            transformOrigin: anchored?.flipped ? 'bottom center' : 'top center',
            willChange: 'transform, opacity',
          }}>
          {/* Search */}
          {searchable && (
            <div style={{ padding: '6px 6px 2px' }}>
                <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                  placeholder="..."
                  aria-label="Search options"
                  onKeyDown={handleSearchKeyboard}
                style={{
                  width: '100%', border: '1px solid var(--border-secondary)', borderRadius: 6,
                  padding: '5px 8px', fontSize: 'calc(12px * var(--fs-scale-body, 1))', outline: 'none', fontFamily: 'inherit',
                  background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}

          {/* Options — capped at whatever the viewport still shows, so a list opened
              beside an on-screen keyboard shrinks instead of hiding under it (#2000). */}
          <div style={{
            maxHeight: Math.min(220, Math.max(96, (anchored?.maxHeight ?? 220) - (searchable ? 38 : 0))),
            overflowY: 'auto',
            // The panel is portaled to document.body and positioned fixed, so its
            // scroll chain runs to the viewport rather than to the sheet it looks
            // like it belongs to. On a phone that meant a flick past either end of
            // the list moved the page instead (#2078).
            overscrollBehavior: 'contain',
            padding: '4px',
          }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '10px 12px', fontSize: 'calc(12px * var(--fs-scale-body, 1))', color: 'var(--text-faint)', textAlign: 'center' }}>—</div>
            ) : (
              filtered.map(option => {
                if (option.isHeader) {
                  return (
                    <div key={option.value} style={{
                      padding: '5px 10px', fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 700, color: 'var(--text-faint)',
                      textTransform: 'uppercase', letterSpacing: '0.03em',
                      background: 'var(--bg-tertiary)', borderRadius: 4, margin: '2px 0',
                    }}>
                      {option.label}
                    </div>
                  )
                }
                const isSelected = option.value === value
                const isActive = option.value === resolvedActiveValue
                return (
                  <button
                    key={option.value}
                    id={`${listboxId}-option-${String(option.value)}`}
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    tabIndex={-1}
                    type="button"
                    onClick={() => { if (!option.disabled) selectValue(option.value) }}
                    onMouseEnter={() => { if (!option.disabled) setActiveValue(option.value) }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px', borderRadius: 6,
                      border: 'none', background: isActive || isSelected ? 'var(--bg-hover)' : 'transparent',
                      color: 'var(--text-primary)', fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontFamily: 'inherit',
                      cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                    }}
                    onMouseLeave={e => e.currentTarget.style.background = isActive || isSelected ? 'var(--bg-hover)' : 'transparent'}
                  >
                    {option.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{option.icon}</span>}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                    {option.badge && (
                      <span style={{
                        flexShrink: 0, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600, color: 'var(--text-muted)',
                        background: 'var(--bg-tertiary)', padding: '2px 7px', borderRadius: 999,
                        letterSpacing: '0.01em',
                      }}>{option.badge}</span>
                    )}
                    {isSelected && <Check size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />}
                  </button>
                )
              })
            )}
          </div>
        </div>,
        document.body
      )}

    </div>
  )
}
