import React from 'react'

export interface ButtonProps {
  label: string
  onClick?: () => void
  onPress?: () => void  // alias for cross-platform ergonomics
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  type?: 'button' | 'submit' | 'reset'
  children?: React.ReactNode
}

export function Button({
  label,
  onClick,
  onPress,
  disabled,
  variant = 'primary',
  type = 'button',
  children,
}: ButtonProps) {
  const variantClass = {
    primary:   'bg-accent text-white hover:bg-accent-hover',
    secondary: 'bg-surface text-primary border border-border hover:bg-surface-raised',
    ghost:     'bg-transparent text-secondary hover:text-primary hover:bg-surface-raised',
    danger:    'bg-curfew text-white',
  }[variant]

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick ?? onPress}
      className={[
        'inline-flex items-center gap-2 h-8 px-3 rounded-md',
        'text-sm font-medium cursor-pointer',
        'transition-colors duration-100 whitespace-nowrap',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        variantClass,
      ].join(' ')}
    >
      {children ?? label}
    </button>
  )
}
