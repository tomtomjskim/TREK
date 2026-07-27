import { useState, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { adminApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { Plus, Trash2, Edit2, Package, X, Check, ChevronDown, ChevronRight, FolderPlus } from 'lucide-react'

interface TemplateCategory { id: number; template_id: number; name: string; sort_order: number }
interface TemplateItem { id: number; category_id: number; name: string; sort_order: number }
interface Template { id: number; name: string; item_count: number; category_count: number; created_by_name: string | null }
interface DetailSession { templateId: number | null; generation: number }

const isSubmitEnter = (event: ReactKeyboardEvent<HTMLInputElement>) =>
  event.key === 'Enter'
  && !event.repeat
  && event.keyCode !== 229
  && !event.nativeEvent.isComposing

const templateMutationKey = (templateId: number) => `mutate-template:${templateId}`

export default function PackingTemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')

  // Expanded template state
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [categories, setCategories] = useState<TemplateCategory[]>([])
  const [items, setItems] = useState<TemplateItem[]>([])
  const [isDetailLoading, setIsDetailLoading] = useState(false)

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
  const [pendingActions, setPendingActions] = useState<Set<string>>(() => new Set())

  const toast = useToast()
  const { t } = useTranslation()
  const toastRef = useRef(toast)
  const translateRef = useRef(t)
  toastRef.current = toast
  translateRef.current = t

  useEffect(() => {
    const loadTemplates = async () => {
      setIsLoading(true)
      try {
        const data = await adminApi.packingTemplates()
        setTemplates(data.templates || [])
      } catch {
        toastRef.current.error(translateRef.current('admin.packingTemplates.loadError'))
      } finally {
        setIsLoading(false)
      }
    }
    void loadTemplates()
  }, [])

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

  const beginDetailSession = (templateId: number | null, isLoading = false) => {
    const session = {
      templateId,
      generation: detailSessionRef.current.generation + 1,
    }
    detailSessionRef.current = session
    setExpandedId(templateId)
    setCategories([])
    setItems([])
    setIsDetailLoading(isLoading)
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

  const refreshCurrentDetail = async (templateId: number) => {
    if (detailSessionRef.current.templateId !== templateId) return
    const session = {
      templateId,
      generation: detailSessionRef.current.generation + 1,
    }
    detailSessionRef.current = session
    setIsDetailLoading(true)
    try {
      const data = await adminApi.getPackingTemplate(templateId)
      if (!isCurrentDetailSession(session)) return
      setCategories(data.categories || [])
      setItems(data.items || [])
    } catch {
      if (isCurrentDetailSession(session)) {
        toast.error(t('admin.packingTemplates.loadError'))
      }
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

  const toggleExpand = async (id: number) => {
    if (detailSessionRef.current.templateId === id) {
      beginDetailSession(null)
      return
    }
    const session = beginDetailSession(id, true)
    try {
      const data = await adminApi.getPackingTemplate(id)
      if (!isCurrentDetailSession(session)) return
      setCategories(data.categories || [])
      setItems(data.items || [])
    } catch {
      if (isCurrentDetailSession(session)) {
        toast.error(t('admin.packingTemplates.loadError'))
      }
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
    await runSingleFlight(
      [`create-category:${templateId}`, templateMutationKey(templateId)],
      async () => {
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
            await refreshCurrentDetail(templateId)
          }
        } catch { toast.error(t('admin.packingTemplates.saveError')) }
      }
    )
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
        const sameTemplate = isCurrentTemplate(session)
        const sameSession = isCurrentDetailSession(session)
        if (sameTemplate) {
          setCategories(prev => prev.map(c => c.id === catId ? { ...c, name } : c))
        }
        if (sameSession) {
          setEditingCatId(current => current === catId ? null : current)
        } else if (sameTemplate) {
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
    await runSingleFlight(
      [`delete-category:${catId}`, templateMutationKey(templateId)],
      async () => {
        try {
          await adminApi.deleteTemplateCategory(templateId, catId)
          const sameTemplate = isCurrentTemplate(session)
          const sameSession = isCurrentDetailSession(session)
          updateTemplateCounts(templateId, -1, -removedItemCount)
          if (sameTemplate) {
            setCategories(prev => prev.filter(c => c.id !== catId))
            setItems(prev => prev.filter(i => i.category_id !== catId))
          }
          if (!sameSession && sameTemplate) await refreshCurrentDetail(templateId)
        } catch { toast.error(t('admin.packingTemplates.deleteError')) }
      }
    )
  }

  // Item CRUD
  const handleAddItem = async (catId: number) => {
    const name = newItemName.trim()
    const session = detailSessionRef.current
    const templateId = session.templateId
    if (!name || !templateId) return
    await runSingleFlight(
      [`create-item:${catId}`, templateMutationKey(templateId)],
      async () => {
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
            await refreshCurrentDetail(templateId)
          }
        } catch { toast.error(t('admin.packingTemplates.saveError')) }
      }
    )
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
        const sameTemplate = isCurrentTemplate(session)
        const sameSession = isCurrentDetailSession(session)
        if (sameTemplate) {
          setItems(prev => prev.map(i => i.id === itemId ? { ...i, name } : i))
        }
        if (sameSession) {
          setEditingItemId(current => current === itemId ? null : current)
        } else if (sameTemplate) {
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
    await runSingleFlight(
      [`delete-item:${itemId}`, templateMutationKey(templateId)],
      async () => {
        try {
          await adminApi.deleteTemplateItem(templateId, itemId)
          const sameTemplate = isCurrentTemplate(session)
          const sameSession = isCurrentDetailSession(session)
          updateTemplateCounts(templateId, 0, -1)
          if (sameTemplate) {
            setItems(prev => prev.filter(i => i.id !== itemId))
          }
          if (!sameSession && sameTemplate) await refreshCurrentDetail(templateId)
        } catch { toast.error(t('admin.packingTemplates.deleteError')) }
      }
    )
  }

  const inputStyle = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent outline-none'
  const btnIcon = 'p-1.5 rounded-lg transition-colors'

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-900">{t('admin.packingTemplates.title')}</h2>
          <p className="text-xs text-slate-400 mt-1">{t('admin.packingTemplates.subtitle')}</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-700 transition-colors">
          <Plus className="w-4 h-4" /> <span className="hidden sm:inline">{t('admin.packingTemplates.create')}</span>
        </button>
      </div>

      {/* Create template */}
      {showCreate && (
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3">
          <Package size={16} className="text-slate-400 flex-shrink-0" />
          <input autoFocus value={createName} onChange={e => setCreateName(e.target.value)}
            disabled={pendingActions.has('create-template')}
            onKeyDown={e => { if (isSubmitEnter(e)) handleCreateTemplate(); if (e.key === 'Escape') setShowCreate(false) }}
            placeholder={t('admin.packingTemplates.namePlaceholder')} className={inputStyle} />
          <button onClick={handleCreateTemplate} disabled={!createName.trim() || pendingActions.has('create-template')}
            className={`${btnIcon} text-slate-600 hover:text-slate-900 disabled:text-slate-300`}><Check size={16} /></button>
          <button onClick={() => setShowCreate(false)} className={`${btnIcon} text-slate-400 hover:text-slate-600`}><X size={16} /></button>
        </div>
      )}

      {/* Template list */}
      {isLoading ? (
        <div className="p-8 text-center"><div className="w-8 h-8 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin mx-auto" /></div>
      ) : templates.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-400">{t('admin.packingTemplates.empty')}</div>
      ) : (
        <div className="divide-y divide-slate-100">
          {templates.map(tmpl => (
            <div key={tmpl.id}>
              {/* Template row */}
              <div className="px-5 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors">
                <button onClick={() => toggleExpand(tmpl.id)} className="text-slate-400 flex-shrink-0 p-0 bg-transparent border-none cursor-pointer">
                  {expandedId === tmpl.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <Package size={16} className="text-slate-400 flex-shrink-0" />
                {editingTemplate === tmpl.id ? (
                  <input autoFocus value={editTemplateName} onChange={e => setEditTemplateName(e.target.value)}
                    onBlur={() => handleRenameTemplate(tmpl.id)}
                    disabled={isTemplateMutationPending(tmpl.id)}
                    onKeyDown={e => { if (isSubmitEnter(e)) handleRenameTemplate(tmpl.id); if (e.key === 'Escape') setEditingTemplate(null) }}
                    className="flex-1 px-2 py-0.5 border border-slate-300 rounded text-sm" />
                ) : (
                  <span onClick={() => toggleExpand(tmpl.id)} className="flex-1 text-sm font-medium text-slate-700 cursor-pointer">{tmpl.name}</span>
                )}
                <span className="text-xs text-slate-400 px-2 py-0.5 bg-slate-100 rounded-full">
                  {tmpl.category_count} {t('admin.packingTemplates.categories')} · {tmpl.item_count} {t('admin.packingTemplates.items')}
                </span>
                <button onClick={() => { committedEditsRef.current.delete(`rename-template:${tmpl.id}`); setEditingTemplate(tmpl.id); setEditTemplateName(tmpl.name) }}
                  disabled={isTemplateMutationPending(tmpl.id)}
                  className={`${btnIcon} hover:bg-slate-100 text-slate-400 hover:text-slate-700 disabled:opacity-40`}><Edit2 size={14} /></button>
                <button onClick={() => handleDeleteTemplate(tmpl.id)} disabled={isTemplateMutationPending(tmpl.id)}
                  className={`${btnIcon} hover:bg-red-50 text-slate-400 hover:text-red-500 disabled:opacity-40`}><Trash2 size={14} /></button>
              </div>

              {/* Expanded content */}
              {expandedId === tmpl.id && (
                <div className="px-5 pb-4 ml-8 space-y-3">
                  {categories.map(cat => {
                    const catItems = items.filter(i => i.category_id === cat.id)
                    return (
                      <div key={cat.id} className="border border-slate-200 rounded-lg overflow-hidden">
                        {/* Category header */}
                        <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-50">
                          {editingCatId === cat.id ? (
                            <>
                              <input autoFocus value={editCatName} onChange={e => setEditCatName(e.target.value)}
                                onBlur={() => handleRenameCategory(cat.id)}
                                disabled={isTemplateMutationPending(tmpl.id)}
                                onKeyDown={e => { if (isSubmitEnter(e)) handleRenameCategory(cat.id); if (e.key === 'Escape') setEditingCatId(null) }}
                                className="flex-1 px-2 py-0.5 border border-slate-300 rounded text-sm font-semibold" />
                            </>
                          ) : (
                            <span className="flex-1 text-xs font-bold text-slate-500 uppercase tracking-wider">{cat.name}</span>
                          )}
                          <span className="text-xs text-slate-400">{catItems.length}</span>
                          <button onClick={() => { setAddingItemToCatId(addingItemToCatId === cat.id ? null : cat.id); setNewItemName(''); setTimeout(() => addItemRef.current?.focus(), 30) }}
                            disabled={isTemplateMutationPending(tmpl.id)}
                            className={`${btnIcon} text-slate-400 hover:text-slate-700 disabled:opacity-40`}><Plus size={13} /></button>
                          <button onClick={() => { committedEditsRef.current.delete(`rename-category:${cat.id}`); setEditingCatId(cat.id); setEditCatName(cat.name) }}
                            disabled={isTemplateMutationPending(tmpl.id)}
                            className={`${btnIcon} text-slate-400 hover:text-slate-700 disabled:opacity-40`}><Edit2 size={13} /></button>
                          <button onClick={() => handleDeleteCategory(cat.id)} disabled={isTemplateMutationPending(tmpl.id)}
                            className={`${btnIcon} text-slate-400 hover:text-red-500 disabled:opacity-40`}><Trash2 size={13} /></button>
                        </div>

                        {/* Items */}
                        {(catItems.length > 0 || addingItemToCatId === cat.id) && (
                          <div className="divide-y divide-slate-50">
                            {catItems.map(item => (
                              <div key={item.id} className="flex items-center gap-3 px-4 py-2 group">
                                {editingItemId === item.id ? (
                                  <>
                                    <input autoFocus value={editItemName} onChange={e => setEditItemName(e.target.value)}
                                      disabled={isTemplateMutationPending(tmpl.id)}
                                      onKeyDown={e => { if (isSubmitEnter(e)) handleRenameItem(item.id); if (e.key === 'Escape') setEditingItemId(null) }}
                                      className="flex-1 px-2 py-1 border border-slate-200 rounded-lg text-sm" />
                                    <button onClick={() => handleRenameItem(item.id)} disabled={isTemplateMutationPending(tmpl.id)}
                                      className="p-1 text-slate-600 hover:text-slate-900 disabled:text-slate-300"><Check size={13} /></button>
                                    <button onClick={() => setEditingItemId(null)} disabled={isTemplateMutationPending(tmpl.id)}
                                      className="p-1 text-slate-400 disabled:opacity-40"><X size={13} /></button>
                                  </>
                                ) : (
                                  <>
                                    <span className="flex-1 text-sm text-slate-700">{item.name}</span>
                                    <button onClick={() => { committedEditsRef.current.delete(`rename-item:${item.id}`); setEditingItemId(item.id); setEditItemName(item.name) }}
                                      disabled={isTemplateMutationPending(tmpl.id)}
                                      className="p-1 rounded opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 transition-all disabled:opacity-40"><Edit2 size={12} /></button>
                                    <button onClick={() => handleDeleteItem(item.id)} disabled={isTemplateMutationPending(tmpl.id)}
                                      className="p-1 rounded opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 transition-all disabled:opacity-40"><Trash2 size={12} /></button>
                                  </>
                                )}
                              </div>
                            ))}

                            {/* Add item inline */}
                            {addingItemToCatId === cat.id && (
                              <div className="flex items-center gap-2 px-4 py-2">
                                <input ref={addItemRef} value={newItemName} onChange={e => setNewItemName(e.target.value)}
                                  disabled={isTemplateMutationPending(tmpl.id)}
                                  onKeyDown={e => { if (isSubmitEnter(e) && newItemName.trim()) handleAddItem(cat.id); if (e.key === 'Escape') { setAddingItemToCatId(null); setNewItemName('') } }}
                                  placeholder={t('admin.packingTemplates.itemName')}
                                  className="min-w-0 flex-1 px-2 py-1 border border-slate-200 rounded-lg text-sm" />
                                <button onClick={() => handleAddItem(cat.id)} disabled={!newItemName.trim() || isTemplateMutationPending(tmpl.id)}
                                  className="p-1.5 rounded-lg bg-slate-900 text-white disabled:bg-slate-300 hover:bg-slate-700 transition-colors"><Plus size={13} /></button>
                                <button onClick={() => { setAddingItemToCatId(null); setNewItemName('') }}
                                  disabled={isTemplateMutationPending(tmpl.id)}
                                  className="p-1 text-slate-400 hover:text-slate-600 disabled:opacity-40"><X size={13} /></button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {/* Add category button */}
                  {addingCategory ? (
                    <div className="flex items-center gap-2">
                      <input autoFocus value={newCatName} onChange={e => setNewCatName(e.target.value)}
                        disabled={isDetailLoading || isTemplateMutationPending(expandedId)}
                        onKeyDown={e => { if (isSubmitEnter(e)) handleAddCategory(); if (e.key === 'Escape') { setAddingCategory(false); setNewCatName('') } }}
                        placeholder={t('admin.packingTemplates.categoryName')}
                        className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" />
                      <button onClick={handleAddCategory} disabled={!newCatName.trim() || isDetailLoading || isTemplateMutationPending(expandedId)}
                        className={`${btnIcon} text-slate-600 hover:text-slate-900 disabled:text-slate-300`}><Check size={15} /></button>
                      <button onClick={() => { setAddingCategory(false); setNewCatName('') }} disabled={isDetailLoading || isTemplateMutationPending(expandedId)}
                        className={`${btnIcon} text-slate-400 disabled:opacity-40`}><X size={15} /></button>
                    </div>
                  ) : (
                    <button onClick={() => setAddingCategory(true)} disabled={isDetailLoading || isTemplateMutationPending(expandedId)}
                      className="flex items-center gap-2 px-3 py-2.5 w-full text-sm text-slate-400 hover:text-slate-600 border border-dashed border-slate-200 rounded-lg hover:border-slate-400 transition-colors disabled:opacity-40">
                      <FolderPlus size={14} /> {t('admin.packingTemplates.addCategory')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
