import { useState, useEffect } from 'react'
import { UserPlus, Check, Loader2, Clock } from 'lucide-react'
import { useVacayStore } from '../../store/vacayStore'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { getApiErrorMessage } from '../../types'
import { useToast } from '../shared/Toast'
import CustomSelect from '../shared/CustomSelect'
import apiClient from '../../api/client'
import VacayBadge from './VacayBadge'
import Modal from '../shared/Modal'

const PRESET_COLORS = [
  '#6366f1', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444',
  '#3b82f6', '#22c55e', '#06b6d4', '#f43f5e', '#a855f7',
  '#10b981', '#0ea5e9', '#64748b', '#be185d', '#0d9488',
]

export default function VacayPersons() {
  const { t } = useTranslation()
  const toast = useToast()
  const { users, pendingInvites, invite, cancelInvite, updateColor, selectedUserId, setSelectedUserId, isFused, isOwner } = useVacayStore()
  const { user: currentUser } = useAuthStore()

  // Default selectedUserId to current user
  useEffect(() => {
    if (!selectedUserId && currentUser) setSelectedUserId(currentUser.id)
  }, [currentUser, selectedUserId])
  const [showInvite, setShowInvite] = useState(false)
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [colorEditUserId, setColorEditUserId] = useState(null)
  const [availableUsers, setAvailableUsers] = useState([])
  const [selectedInviteUser, setSelectedInviteUser] = useState(null)
  const [inviting, setInviting] = useState(false)

  const loadAvailable = async () => {
    try {
      const data = await apiClient.get('/addons/vacay/available-users').then(r => r.data)
      setAvailableUsers(data.users)
    } catch { /* */ }
  }

  const handleInvite = async () => {
    if (!selectedInviteUser) return
    setInviting(true)
    try {
      await invite(selectedInviteUser)
      toast.success(t('vacay.inviteSent'))
      setShowInvite(false)
      setSelectedInviteUser(null)
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('vacay.inviteError')))
    } finally {
      setInviting(false)
    }
  }

  const handleColorChange = async (color: string) => {
    await updateColor(color, colorEditUserId)
    setShowColorPicker(false)
    setColorEditUserId(null)
  }

  const editingUserColor = users.find(u => u.id === colorEditUserId)?.color || '#6366f1'

  return (
    <div className="vg-card rounded-[22px]" style={{ padding: '14px 18px' }}>
      <div className="flex items-center justify-between mb-2">
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--vg-ink3)' }}>{t('vacay.persons')}</span>
        <button type="button" onClick={() => { setShowInvite(true); loadAvailable() }}
          aria-label={t('vacay.inviteUser')}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
          style={{ color: 'var(--vg-ink3)' }}>
          <UserPlus size={15} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {users.map(u => {
          const isSelected = selectedUserId === u.id
          return (
            <div key={u.id}
              className="flex items-center gap-2.5 group transition-colors"
              style={{
                padding: '7px 10px',
                borderRadius: 12,
                cursor: 'default',
                background: isSelected ? 'var(--vg-surf2)' : 'transparent',
                border: `1px solid ${isSelected ? 'var(--vg-line)' : 'transparent'}`,
              }}>
              <button type="button"
                onClick={() => { setColorEditUserId(u.id); setShowColorPicker(true) }}
                className="w-3 h-3 rounded-full shrink-0 transition-transform hover:scale-125"
                style={{ backgroundColor: u.color, cursor: 'pointer' }}
                title={t('vacay.changeColor')}
              />
              {isFused ? (
                <button type="button" onClick={() => setSelectedUserId(u.id)}
                  aria-pressed={isSelected}
                  className="flex min-w-0 flex-1 items-center gap-2 bg-transparent p-0 text-left">
                  <span className="truncate min-w-0" style={{ fontSize: 13, fontWeight: 600, color: 'var(--vg-ink)' }}>{u.username}</span>
                  {u.id === currentUser?.id && <VacayBadge label={t('vacay.you')} />}
                  {isSelected && <Check size={15} strokeWidth={2.4} className="ml-auto" style={{ color: 'var(--vg-ink2)' }} />}
                </button>
              ) : (
                <span className="truncate min-w-0" style={{ fontSize: 13, fontWeight: 600, color: 'var(--vg-ink)' }}>
                  {u.username}
                  {u.id === currentUser?.id && <span className="ml-2"><VacayBadge label={t('vacay.you')} /></span>}
                </span>
              )}
            </div>
          )
        })}

        {/* Pending invites */}
        {pendingInvites.map(inv => (
          <div key={inv.user_id} className="flex items-center gap-2.5 group"
            style={{ padding: '7px 10px', borderRadius: 12, background: 'var(--vg-surf2)', opacity: 0.7 }}>
            <Clock size={13} style={{ color: 'var(--vg-ink3)' }} />
            <span className="truncate min-w-0" style={{ fontSize: 13, color: 'var(--vg-ink2)' }}>
              {inv.username}
            </span>
            <VacayBadge label={t('vacay.pending')} tone="amber" />
            {isOwner && <button type="button" onClick={() => cancelInvite(inv.user_id)}
              className="ml-auto opacity-0 group-hover:opacity-100 text-[10px] px-1.5 py-0.5 rounded transition-all"
              style={{ color: 'var(--vg-ink3)' }}>
              {t('common.cancel')}
            </button>}
          </div>
        ))}
      </div>

      <Modal
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        title={t('vacay.inviteUser')}
        size="sm"
        closeLabel={t('common.close')}
        zIndex={99990}
      >
        <div className="space-y-4">
          <p className="text-xs text-content-muted">{t('vacay.inviteHint')}</p>
          {availableUsers.length === 0 ? (
            <p className="text-xs text-center py-4 text-content-faint">{t('vacay.noUsersAvailable')}</p>
          ) : (
            <CustomSelect
              value={selectedInviteUser}
              onChange={setSelectedInviteUser}
              options={availableUsers.map(u => ({ value: u.id, label: `${u.username} (${u.email})` }))}
              placeholder={t('vacay.selectUser')}
              searchable
            />
          )}
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setShowInvite(false)} className="px-4 py-2 text-sm rounded-lg text-content-muted border border-edge">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={handleInvite} disabled={!selectedInviteUser || inviting}
              className="px-4 py-2 text-sm rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-40 bg-content text-surface-card">
              {inviting && <Loader2 size={13} className="animate-spin" />}
              {t('vacay.sendInvite')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showColorPicker}
        onClose={() => { setShowColorPicker(false); setColorEditUserId(null) }}
        title={t('vacay.changeColor')}
        size="sm"
        closeLabel={t('common.close')}
        zIndex={99990}
      >
        <div className="flex flex-wrap gap-2 justify-center">
          {PRESET_COLORS.map(c => (
            <button type="button" key={c} onClick={() => handleColorChange(c)}
              aria-label={c}
              aria-pressed={editingUserColor === c}
              className={`w-8 h-8 rounded-full transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${editingUserColor === c ? 'ring-2 ring-offset-2 scale-110' : 'hover:scale-110'}`}
              style={{ backgroundColor: c }} />
          ))}
        </div>
      </Modal>
    </div>
  )
}
