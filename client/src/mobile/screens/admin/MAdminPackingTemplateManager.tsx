import { useState, useEffect, useRef, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { adminApi } from '../../../api/client'
import { useToast } from '../../../components/shared/Toast'
import { useTranslation } from '../../../i18n'
import { Plus, Trash2, Edit2, Package, X, Check, ChevronDown, ChevronRight, FolderPlus } from 'lucide-react'
import { MAdminButton, MAdminCard, MAdminCardHead, MAdminInput } from './MAdminUi'

interface TemplateCategory { id: number; template_id: number; name: string; sort_order: number }
interface TemplateItem { id: number; category_id: number; name: string; sort_order: number }
interface Template { id: number; name: string; item_count: number; category_count: number; created_by_name: string }
interface DetailSession { templateId: number | null; generation: number }

const isSubmitEnter = (event: ReactKeyboardEvent<HTMLInputElement>) =>
  event.key === 'Enter'
  && !event.repeat
  && event.keyCode !== 229
  && !event.nativeEvent.isComposing

const templateMutationKey = (templateId: number) => `mutate-template:${templateId}`

// Small round icon action button in the mobile admin idiom (flat --m-ic circle).
function PkIconBtn({
  onClick,
  ariaLabel,
  variant = 'neutral',
  size = 32,
  disabled = false,
  children,
}: {
  onClick: () => void
  ariaLabel: string
  variant?: 'neutral' | 'danger' | 'accent'
  size?: number
  disabled?: boolean
  children: ReactNode
}) {
  const look =
    variant === 'accent'
      ? 'bg-m-act text-m-actfg'
      : variant === 'danger'
        ? 'bg-[color:var(--m-ic)] text-[color:var(--m-st-danger)]'
        : 'bg-[color:var(--m-ic)] text-m-muted'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`flex flex-none items-center justify-center rounded-full disabled:opacity-40 ${look}`}
      style={{ width: size, height: size }}
    >
      {children}
    </button>
  )
}

// Compact inline field matching MAdminInput, used where a native ref is needed
// (the add-item input focuses itself after each add).
const inlineFieldCls =
  'h-[38px] w-full rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 text-[0.84375rem] text-m-ink outline-none placeholder:text-m-faint focus:border-[color:var(--m-faint)]'

/**
 * Mobile-native re-skin of the admin Packing Template Manager: create/rename/
 * delete templates, expand a template to manage its categories and items. All
 * state, effects and adminApi mutations are preserved from the desktop version.
 */
export default function MAdminPackingTemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')

  // Expanded template state
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [categories, setCategories] = useState<TemplateCategory[]>([])
  const [items, setItems] = useState<TemplateItem[]>([])

  // Editing states
  const [editingTemplate, setEditingTemplate] = useState<number | null>(null)
  const [editTemplateName, setEditTemplateName] = useState('')
  const [editingCatId, setEditingCatId] = useState<number | null>(null)
  const [editCatName, setEditCatName] = useState('')
  const [editingItemId, setEditingItemId] = useState<number | null>(null)
  const [editItemName, setEditItemName] = useState('')

  // Adding states
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [addingItemToCatId, setAddingItemToCatId] = useState<number | null>(null)
  const [newItemName, setNewItemName] = useState('')
  const addItemRef = useRef<HTMLInputElement>(null)
  const pendingActionsRef = useRef(new Set<string>())
  const committedEditsRef = useRef(new Set<string>())
  const detailSessionRef = useRef<DetailSession>({ templateId: null, generation: 0 })
  const lastExpandedTemplateIdRef = useRef<number | null>(null)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set())

  const toast = useToast()
  const { t } = useTranslation()
  const toastRef = useRef(toast)
  const translateRef = useRef(t)
  toastRef.current = toast
  translateRef.current = t

  const runSingleFlight = async (keyOrKeys: string | string[], action: () => Promise<void>) => {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]
    if (keys.some(key => pendingActionsRef.current.has(key))) return
    keys.forEach(key => pendingActionsRef.current.add(key))
    setPendingActions(prev => {
      const next = new Set(prev)
      keys.forEach(key => next.add(key))
      return next
    })
    try {
      await action()
    } finally {
      keys.forEach(key => pendingActionsRef.current.delete(key))
      setPendingActions(prev => {
        const next = new Set(prev)
        keys.forEach(key => next.delete(key))
        return next
      })
    }
  }

  const beginDetailSession = (templateId: number | null, loading = false) => {
    const session = {
      templateId,
      generation: detailSessionRef.current.generation + 1,
    }
    detailSessionRef.current = session
    setExpandedId(templateId)
    setCategories([])
    setItems([])
    setIsDetailLoading(loading)
    setAddingCategory(false)
    setNewCatName('')
    setAddingItemToCatId(null)
    setNewItemName('')
    setEditingCatId(null)
    setEditingItemId(null)
    return session
  }

  const isCurrentDetailSession = (session: DetailSession) =>
    detailSessionRef.current.templateId === session.templateId
    && detailSessionRef.current.generation === session.generation

  const isCurrentTemplate = (session: DetailSession) =>
    session.templateId !== null && detailSessionRef.current.templateId === session.templateId

  const isTemplateMutationPending = (templateId: number | null) =>
    templateId !== null && pendingActions.has(templateMutationKey(templateId))

  const applyDetailData = (
    session: DetailSession,
    data: { categories?: TemplateCategory[]; items?: TemplateItem[] },
    syncSummary = false,
  ) => {
    if (!isCurrentDetailSession(session)) return false
    const nextCategories = data.categories || []
    const nextItems = data.items || []
    setCategories(nextCategories)
    setItems(nextItems)
    if (syncSummary && session.templateId !== null) {
      setTemplates(prev => prev.map(template => template.id === session.templateId
        ? { ...template, category_count: nextCategories.length, item_count: nextItems.length }
        : template))
    }
    return true
  }

  const refreshCurrentDetail = async (
    templateId: number,
    options: {
      syncSummary?: boolean
      accept?: (data: { categories?: TemplateCategory[]; items?: TemplateItem[] }) => boolean
    } = {},
  ) => {
    if (detailSessionRef.current.templateId !== templateId) return
    const session = {
      templateId,
      generation: detailSessionRef.current.generation + 1,
    }
    detailSessionRef.current = session
    setIsDetailLoading(true)
    try {
      const data = await adminApi.getPackingTemplate(templateId)
      if (options.accept && !options.accept(data)) return
      applyDetailData(session, data, options.syncSummary)
    } catch {
      if (isCurrentDetailSession(session)) toast.error(t('admin.packingTemplates.loadError'))
    } finally {
      if (isCurrentDetailSession(session)) setIsDetailLoading(false)
    }
  }

  const updateTemplateCounts = (templateId: number, categoryDelta: number, itemDelta: number) => {
    setTemplates(prev => prev.map(template => template.id === templateId
      ? {
          ...template,
          category_count: Math.max(0, template.category_count + categoryDelta),
          item_count: Math.max(0, template.item_count + itemDelta),
        }
      : template))
  }

  useEffect(() => {
    const loadTemplates = async () => {
      setIsLoading(true)
      try {
        const data = await adminApi.packingTemplates()
        setTemplates(data.templates || [])
      } catch { toastRef.current.error(translateRef.current('admin.packingTemplates.loadError')) }
      finally { setIsLoading(false) }
    }
    void loadTemplates()
  }, [])

  const toggleExpand = async (id: number) => {
    if (detailSessionRef.current.templateId === id) { beginDetailSession(null); return }
    const isSameTemplateReopen = detailSessionRef.current.templateId === null
      && lastExpandedTemplateIdRef.current === id
    const canSyncSummary = isSameTemplateReopen
      && !pendingActionsRef.current.has(templateMutationKey(id))
    const session = beginDetailSession(id, true)
    lastExpandedTemplateIdRef.current = id
    try {
      const data = await adminApi.getPackingTemplate(id)
      if (!isCurrentDetailSession(session)) return
      applyDetailData(session, data, canSyncSummary && !pendingActionsRef.current.has(templateMutationKey(id)))
    } catch {
      if (isCurrentDetailSession(session)) toast.error(t('admin.packingTemplates.loadError'))
    } finally {
      if (isCurrentDetailSession(session)) setIsDetailLoading(false)
    }
  }

  // Template CRUD
  const handleCreateTemplate = async () => {
    const name = createName.trim()
    if (!name) return
    await runSingleFlight('create-template', async () => {
      try {
        const data = await adminApi.createPackingTemplate({ name })
        setTemplates(prev => [{ ...data.template, item_count: 0, category_count: 0 }, ...prev])
        setCreateName(''); setShowCreate(false)
        beginDetailSession(data.template.id)
        toast.success(t('admin.packingTemplates.created'))
      } catch { toast.error(t('admin.packingTemplates.createError')) }
    })
  }

  const handleDeleteTemplate = async (id: number) => {
    await runSingleFlight([`delete-template:${id}`, templateMutationKey(id)], async () => {
      try {
        await adminApi.deletePackingTemplate(id)
        setTemplates(prev => prev.filter(t => t.id !== id))
        if (detailSessionRef.current.templateId === id) beginDetailSession(null)
        toast.success(t('admin.packingTemplates.deleted'))
      } catch { toast.error(t('admin.packingTemplates.deleteError')) }
    })
  }

  const handleRenameTemplate = async (id: number) => {
    const name = editTemplateName.trim()
    const actionKey = `rename-template:${id}`
    if (!name) { setEditingTemplate(null); return }
    if (committedEditsRef.current.has(actionKey)) return
    await runSingleFlight([actionKey, templateMutationKey(id)], async () => {
      if (committedEditsRef.current.has(actionKey)) return
      committedEditsRef.current.add(actionKey)
      try {
        await adminApi.updatePackingTemplate(id, { name })
        setTemplates(prev => prev.map(t => t.id === id ? { ...t, name } : t))
        setEditingTemplate(current => current === id ? null : current)
      } catch {
        committedEditsRef.current.delete(actionKey)
        toast.error(t('admin.packingTemplates.saveError'))
      }
    })
  }

  // Category CRUD
  const handleAddCategory = async () => {
    const name = newCatName.trim()
    const session = detailSessionRef.current
    const templateId = session.templateId
    if (!name || !templateId) return
    await runSingleFlight([`create-category:${templateId}`, templateMutationKey(templateId)], async () => {
      try {
        const data = await adminApi.addTemplateCategory(templateId, { name })
        const sameTemplate = isCurrentTemplate(session)
        const sameSession = isCurrentDetailSession(session)
        updateTemplateCounts(templateId, 1, 0)
        if (sameTemplate) {
          setCategories(prev => prev.some(category => category.id === data.category.id)
            ? prev.map(category => category.id === data.category.id ? data.category : category)
            : [...prev, data.category])
        }
        if (sameSession) {
          setNewCatName(''); setAddingCategory(false)
        } else if (sameTemplate) {
          await refreshCurrentDetail(templateId, { syncSummary: true })
        }
      } catch { toast.error(t('admin.packingTemplates.saveError')) }
    })
  }

  const handleRenameCategory = async (catId: number) => {
    const name = editCatName.trim()
    const session = detailSessionRef.current
    const templateId = session.templateId
    const actionKey = `rename-category:${catId}`
    if (!name || !templateId) { setEditingCatId(null); return }
    if (committedEditsRef.current.has(actionKey)) return
    await runSingleFlight([actionKey, templateMutationKey(templateId)], async () => {
      if (committedEditsRef.current.has(actionKey)) return
      committedEditsRef.current.add(actionKey)
      try {
        await adminApi.updateTemplateCategory(templateId, catId, { name })
        if (isCurrentTemplate(session)) setCategories(prev => prev.map(c => c.id === catId ? { ...c, name } : c))
        if (isCurrentDetailSession(session)) {
          setEditingCatId(current => current === catId ? null : current)
        } else if (isCurrentTemplate(session)) {
          await refreshCurrentDetail(templateId)
        }
      } catch {
        committedEditsRef.current.delete(actionKey)
        toast.error(t('admin.packingTemplates.saveError'))
      }
    })
  }

  const handleDeleteCategory = async (catId: number) => {
    const session = detailSessionRef.current
    const templateId = session.templateId
    if (!templateId) return
    const removedItemCount = items.filter(item => item.category_id === catId).length
    await runSingleFlight([`delete-category:${catId}`, templateMutationKey(templateId)], async () => {
      try {
        await adminApi.deleteTemplateCategory(templateId, catId)
        const sameTemplate = isCurrentTemplate(session)
        updateTemplateCounts(templateId, -1, -removedItemCount)
        if (sameTemplate) {
          setCategories(prev => prev.filter(c => c.id !== catId))
          setItems(prev => prev.filter(i => i.category_id !== catId))
          await refreshCurrentDetail(templateId, {
            syncSummary: true,
            accept: data => !data.categories?.some(category => category.id === catId),
          })
        }
      } catch { toast.error(t('admin.toast.deleteError')) }
    })
  }

  // Item CRUD
  const handleAddItem = async (catId: number) => {
    const name = newItemName.trim()
    const session = detailSessionRef.current
    const templateId = session.templateId
    if (!name || !templateId) return
    await runSingleFlight([`create-item:${catId}`, templateMutationKey(templateId)], async () => {
      try {
        const data = await adminApi.addTemplateItem(templateId, catId, { name })
        const sameTemplate = isCurrentTemplate(session)
        const sameSession = isCurrentDetailSession(session)
        updateTemplateCounts(templateId, 0, 1)
        if (sameTemplate) {
          setItems(prev => prev.some(item => item.id === data.item.id)
            ? prev.map(item => item.id === data.item.id ? data.item : item)
            : [...prev, data.item])
        }
        if (sameSession) {
          setNewItemName('')
          setTimeout(() => addItemRef.current?.focus(), 30)
        } else if (sameTemplate) {
          await refreshCurrentDetail(templateId, { syncSummary: true })
        }
      } catch { toast.error(t('admin.packingTemplates.saveError')) }
    })
  }

  const handleRenameItem = async (itemId: number) => {
    const name = editItemName.trim()
    const session = detailSessionRef.current
    const templateId = session.templateId
    const actionKey = `rename-item:${itemId}`
    if (!name || !templateId) { setEditingItemId(null); return }
    if (committedEditsRef.current.has(actionKey)) return
    await runSingleFlight([actionKey, templateMutationKey(templateId)], async () => {
      if (committedEditsRef.current.has(actionKey)) return
      committedEditsRef.current.add(actionKey)
      try {
        await adminApi.updateTemplateItem(templateId, itemId, { name })
        if (isCurrentTemplate(session)) setItems(prev => prev.map(i => i.id === itemId ? { ...i, name } : i))
        if (isCurrentDetailSession(session)) {
          setEditingItemId(current => current === itemId ? null : current)
        } else if (isCurrentTemplate(session)) {
          await refreshCurrentDetail(templateId)
        }
      } catch {
        committedEditsRef.current.delete(actionKey)
        toast.error(t('admin.packingTemplates.saveError'))
      }
    })
  }

  const handleDeleteItem = async (itemId: number) => {
    const session = detailSessionRef.current
    const templateId = session.templateId
    if (!templateId) return
    await runSingleFlight([`delete-item:${itemId}`, templateMutationKey(templateId)], async () => {
      try {
        await adminApi.deleteTemplateItem(templateId, itemId)
        const sameTemplate = isCurrentTemplate(session)
        const sameSession = isCurrentDetailSession(session)
        updateTemplateCounts(templateId, 0, -1)
        if (sameTemplate) setItems(prev => prev.filter(i => i.id !== itemId))
        if (!sameSession && sameTemplate) await refreshCurrentDetail(templateId, { syncSummary: true })
      } catch { toast.error(t('admin.toast.deleteError')) }
    })
  }

  return (
    <div data-testid="packing-template-manager" className="block w-full">
      <MAdminCard>
      {/* Header */}
      <MAdminCardHead
        title={t('admin.packingTemplates.title')}
        hint={t('admin.packingTemplates.subtitle')}
        trailing={
          <MAdminButton disabled={pendingActions.has('create-template')} onClick={() => setShowCreate(true)}>
            <Plus size={13} strokeWidth={2.4} />
            {t('admin.packingTemplates.create')}
          </MAdminButton>
        }
      />

      {/* Create template */}
      {showCreate && (
        <div className="mt-2 flex items-center gap-2">
          <Package size={16} className="flex-none text-m-faint" />
          <div className="min-w-0 flex-1">
            <MAdminInput
              autoFocus
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              disabled={pendingActions.has('create-template')}
              onKeyDown={e => { if (isSubmitEnter(e)) handleCreateTemplate(); if (e.key === 'Escape') setShowCreate(false) }}
              placeholder={t('admin.packingTemplates.namePlaceholder')}
            />
          </div>
          <PkIconBtn ariaLabel={t('common.save')} variant="accent" disabled={pendingActions.has('create-template')} onClick={handleCreateTemplate}><Check size={15} /></PkIconBtn>
          <PkIconBtn ariaLabel={t('common.cancel')} onClick={() => setShowCreate(false)}><X size={15} /></PkIconBtn>
        </div>
      )}

      {/* Template list */}
      {isLoading ? (
        <div className="py-8 text-center">
          <span className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-[color:var(--m-rowbr)] border-t-[color:var(--m-ink)]" />
        </div>
      ) : templates.length === 0 ? (
        <div className="py-8 text-center font-geist text-[0.75rem] text-m-faint">{t('admin.packingTemplates.empty')}</div>
      ) : (
        <div className="mt-1">
          {templates.map(tmpl => (
            <div key={tmpl.id} className="border-t border-[color:var(--m-rowbr)] first:border-t-0">
              {/* Template row */}
              <div className="flex items-center gap-2 py-[11px]">
                <button
                  type="button"
                  aria-label={expandedId === tmpl.id ? t('common.collapse') : t('common.expand')}
                  onClick={() => toggleExpand(tmpl.id)}
                  className="flex-none text-m-faint"
                >
                  {expandedId === tmpl.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <Package size={16} className="flex-none text-m-faint" />
                {editingTemplate === tmpl.id ? (
                  <div className="min-w-0 flex-1">
                    <MAdminInput
                      autoFocus
                      value={editTemplateName}
                      onChange={e => setEditTemplateName(e.target.value)}
                      onBlur={() => handleRenameTemplate(tmpl.id)}
                      disabled={isTemplateMutationPending(tmpl.id)}
                      onKeyDown={e => { if (isSubmitEnter(e)) handleRenameTemplate(tmpl.id); if (e.key === 'Escape') setEditingTemplate(null) }}
                    />
                  </div>
                ) : (
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleExpand(tmpl.id)}>
                    <div className="truncate text-[0.8125rem] font-bold text-m-ink">{tmpl.name}</div>
                    <div className="mt-[1px] font-geist text-[0.59375rem] text-m-faint">
                      {tmpl.category_count} {t('admin.packingTemplates.categories')} · {tmpl.item_count} {t('admin.packingTemplates.items')}
                    </div>
                  </button>
                )}
                <PkIconBtn
                  ariaLabel={t('common.edit')}
                  disabled={isTemplateMutationPending(tmpl.id)}
                  onClick={() => { committedEditsRef.current.delete(`rename-template:${tmpl.id}`); setEditingTemplate(tmpl.id); setEditTemplateName(tmpl.name) }}
                ><Edit2 size={14} /></PkIconBtn>
                <PkIconBtn
                  ariaLabel={t('common.delete')}
                  variant="danger"
                  disabled={isTemplateMutationPending(tmpl.id)}
                  onClick={() => handleDeleteTemplate(tmpl.id)}
                ><Trash2 size={14} /></PkIconBtn>
              </div>

              {/* Expanded content */}
              {expandedId === tmpl.id && (
                <div className="space-y-2 pb-3 pl-6">
                  {categories.map(cat => {
                    const catItems = items.filter(i => i.category_id === cat.id)
                    return (
                      <div key={cat.id} className="overflow-hidden rounded-xl border border-[color:var(--m-rowbr)]">
                        {/* Category header */}
                        <div className="flex items-center gap-1.5 bg-[color:var(--m-ic)] px-3 py-2">
                          {editingCatId === cat.id ? (
                            <div className="min-w-0 flex-1">
                              <MAdminInput
                                autoFocus
                                value={editCatName}
                                onChange={e => setEditCatName(e.target.value)}
                                onBlur={() => handleRenameCategory(cat.id)}
                                disabled={isTemplateMutationPending(tmpl.id)}
                                onKeyDown={e => { if (isSubmitEnter(e)) handleRenameCategory(cat.id); if (e.key === 'Escape') setEditingCatId(null) }}
                              />
                            </div>
                          ) : (
                            <span className="min-w-0 flex-1 truncate font-geist text-[0.625rem] font-bold uppercase tracking-wider text-m-muted">{cat.name}</span>
                          )}
                          <span className="flex-none font-geist text-[0.625rem] text-m-faint">{catItems.length}</span>
                          <PkIconBtn
                            size={28}
                            ariaLabel={t('admin.packingTemplates.itemName')}
                            disabled={isDetailLoading || isTemplateMutationPending(tmpl.id)}
                            onClick={() => { setAddingItemToCatId(addingItemToCatId === cat.id ? null : cat.id); setNewItemName(''); setTimeout(() => addItemRef.current?.focus(), 30) }}
                          ><Plus size={14} /></PkIconBtn>
                          <PkIconBtn
                            size={28}
                            ariaLabel={t('common.edit')}
                            disabled={isDetailLoading || isTemplateMutationPending(tmpl.id)}
                            onClick={() => { committedEditsRef.current.delete(`rename-category:${cat.id}`); setEditingCatId(cat.id); setEditCatName(cat.name) }}
                          ><Edit2 size={13} /></PkIconBtn>
                          <PkIconBtn
                            size={28}
                            variant="danger"
                            ariaLabel={t('common.delete')}
                            disabled={isDetailLoading || isTemplateMutationPending(tmpl.id)}
                            onClick={() => handleDeleteCategory(cat.id)}
                          ><Trash2 size={13} /></PkIconBtn>
                        </div>

                        {/* Items */}
                        {(catItems.length > 0 || addingItemToCatId === cat.id) && (
                          <div className="divide-y divide-[color:var(--m-rowbr)]">
                            {catItems.map(item => (
                              <div key={item.id} className="flex items-center gap-2 px-3 py-2">
                                {editingItemId === item.id ? (
                                  <>
                                    <div className="min-w-0 flex-1">
                                      <MAdminInput
                                        autoFocus
                                        value={editItemName}
                                        onChange={e => setEditItemName(e.target.value)}
                                        disabled={isTemplateMutationPending(tmpl.id)}
                                        onKeyDown={e => { if (isSubmitEnter(e)) handleRenameItem(item.id); if (e.key === 'Escape') setEditingItemId(null) }}
                                      />
                                    </div>
                                    <PkIconBtn size={28} variant="accent" ariaLabel={t('common.save')} disabled={isTemplateMutationPending(tmpl.id)} onClick={() => handleRenameItem(item.id)}><Check size={13} /></PkIconBtn>
                                    <PkIconBtn size={28} ariaLabel={t('common.cancel')} disabled={isTemplateMutationPending(tmpl.id)} onClick={() => setEditingItemId(null)}><X size={13} /></PkIconBtn>
                                  </>
                                ) : (
                                  <>
                                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-m-ink">{item.name}</span>
                                    <PkIconBtn
                                      size={28}
                                      ariaLabel={t('common.edit')}
                                      disabled={isTemplateMutationPending(tmpl.id)}
                                      onClick={() => { committedEditsRef.current.delete(`rename-item:${item.id}`); setEditingItemId(item.id); setEditItemName(item.name) }}
                                    ><Edit2 size={12} /></PkIconBtn>
                                    <PkIconBtn
                                      size={28}
                                      variant="danger"
                                      ariaLabel={t('common.delete')}
                                      disabled={isTemplateMutationPending(tmpl.id)}
                                      onClick={() => handleDeleteItem(item.id)}
                                    ><Trash2 size={12} /></PkIconBtn>
                                  </>
                                )}
                              </div>
                            ))}

                            {/* Add item inline */}
                            {addingItemToCatId === cat.id && (
                              <div className="flex items-center gap-2 px-3 py-2">
                                <input
                                  ref={addItemRef}
                                  value={newItemName}
                                  onChange={e => setNewItemName(e.target.value)}
                                  disabled={isDetailLoading || isTemplateMutationPending(tmpl.id)}
                                  onKeyDown={e => { if (isSubmitEnter(e) && newItemName.trim()) handleAddItem(cat.id); if (e.key === 'Escape') { setAddingItemToCatId(null); setNewItemName('') } }}
                                  placeholder={t('admin.packingTemplates.itemName')}
                                  className={inlineFieldCls}
                                />
                                <PkIconBtn size={28} variant="accent" disabled={!newItemName.trim() || isDetailLoading || isTemplateMutationPending(tmpl.id)} ariaLabel={t('admin.packingTemplates.itemName')} onClick={() => handleAddItem(cat.id)}><Plus size={13} /></PkIconBtn>
                                <PkIconBtn size={28} ariaLabel={t('common.cancel')} disabled={isDetailLoading || isTemplateMutationPending(tmpl.id)} onClick={() => { setAddingItemToCatId(null); setNewItemName('') }}><X size={13} /></PkIconBtn>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {/* Add category */}
                  {addingCategory ? (
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <MAdminInput
                          autoFocus
                          value={newCatName}
                          onChange={e => setNewCatName(e.target.value)}
                          disabled={isDetailLoading || isTemplateMutationPending(expandedId)}
                          onKeyDown={e => { if (isSubmitEnter(e)) handleAddCategory(); if (e.key === 'Escape') { setAddingCategory(false); setNewCatName('') } }}
                          placeholder={t('admin.packingTemplates.categoryName')}
                        />
                      </div>
                      <PkIconBtn variant="accent" ariaLabel={t('common.save')} disabled={!newCatName.trim() || isDetailLoading || isTemplateMutationPending(expandedId)} onClick={handleAddCategory}><Check size={15} /></PkIconBtn>
                      <PkIconBtn ariaLabel={t('common.cancel')} disabled={isDetailLoading || isTemplateMutationPending(expandedId)} onClick={() => { setAddingCategory(false); setNewCatName('') }}><X size={15} /></PkIconBtn>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={isDetailLoading || isTemplateMutationPending(expandedId)}
                      onClick={() => setAddingCategory(true)}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[color:var(--m-rowbr)] px-3 py-[10px] font-geist text-[0.75rem] font-semibold text-m-muted"
                    >
                      <FolderPlus size={14} /> {t('admin.packingTemplates.addCategory')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </MAdminCard>
    </div>
  )
}
