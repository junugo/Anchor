import React from 'react'
import { Button } from './Button'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-lg w-[320px] p-4 transition-all duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-primary">{title}</div>
        {description && (
          <div className="mt-1.5 text-xs text-secondary leading-normal">{description}</div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button label={cancelLabel} variant="ghost" onClick={onCancel} />
          <Button label={confirmLabel} variant={danger ? 'danger' : 'primary'} onClick={onConfirm} />
        </div>
      </div>
    </div>
  )
}
