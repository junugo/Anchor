import React from 'react'

export interface TextInputProps {
  value: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  onChangeText?: (text: string) => void  // cross-platform alias
  placeholder?: string
  type?: React.HTMLInputTypeAttribute
  multiline?: boolean  // renders <textarea> when true
  disabled?: boolean
}

export function TextInput({
  value,
  onChange,
  onChangeText,
  placeholder,
  type = 'text',
  multiline,
  disabled,
}: TextInputProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onChange?.(e as React.ChangeEvent<HTMLInputElement>)
    onChangeText?.(e.target.value)
  }

  const baseClass = [
    'bg-surface text-primary border border-border rounded-md',
    'px-3 py-2 text-body font-sans outline-none w-full',
    'placeholder:text-disabled focus:border-accent',
    'transition-colors duration-100',
    'disabled:opacity-45',
  ].join(' ')

  if (multiline) {
    return (
      <textarea
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
        className={`${baseClass} resize-y leading-normal`}
      />
    )
  }

  return (
    <input
      type={type}
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      disabled={disabled}
      className={baseClass}
    />
  )
}
