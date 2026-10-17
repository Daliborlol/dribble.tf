import { useEffect, useState } from 'react'
import { clamp } from 'lodash'

import { cn } from '@utils/styling'

// Settings panel rows, shared by SettingsPanel and the Highlander settings section.

//
// ─── BASE OPTION WRAPPER ────────────────────────────────────────────────────────
//

export type OptionProps = {
  label: string
  keyCode?: string
  children?: React.ReactNode
  leftClass?: string
  rightClass?: string
  onClickLabel?: () => void
}

export const Option = ({
  label,
  keyCode,
  children,
  leftClass = '',
  rightClass = '',
  onClickLabel,
}: OptionProps) => (
  <div className="mb-4 flex items-center justify-between">
    <div className={cn('flex items-center', leftClass)}>
      <div
        className={cn('select-none text-base font-semibold', !!onClickLabel && 'cursor-default')}
        onClick={onClickLabel}
      >
        {label}
      </div>
      {!!keyCode && <kbd className="ml-2 text-[66%]">{keyCode}</kbd>}
    </div>

    <div className={cn('flex items-center', rightClass)}>{children}</div>
  </div>
)

//
// ─── SLIDER OPTION ──────────────────────────────────────────────────────────────
//

export type SliderOptionProps = {
  label: string
  keyCode?: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  inputClassName?: string
}

export const SliderOption = ({
  label,
  keyCode,
  value,
  onChange,
  min = 1,
  max = 10,
  step = 0.1,
  inputClassName = 'w-10',
}: SliderOptionProps) => {
  // Track value internally so that input[type=number] will only trigger
  // callback when appropriate (i.e. enter / up / down / blurred)
  const [val, setVal] = useState(value)
  const inputFields = { min: min, max: max, step: step }

  useEffect(() => {
    setVal(value)
  }, [value])

  const callback = (newValue: number) => {
    setVal(clamp(newValue, min, max))
    onChange(clamp(newValue, min, max))
  }

  return (
    <Option label={label} keyCode={keyCode} leftClass="w-5/12" rightClass="w-7/12">
      <input
        type="range"
        className="slider h-[2px] flex-1 cursor-pointer rounded-md bg-white/30 outline-offset-4 [-webkit-appearance:none]"
        value={val}
        onChange={({ target }) => callback(Number(target.value))}
        {...inputFields}
      />
      <input
        type="number"
        className={cn(
          'ml-4 rounded-md border border-white/40 bg-transparent px-1 text-right text-base',
          inputClassName
        )}
        value={val}
        onChange={({ target }) => setVal(Number(target.value))}
        onBlur={() => callback(val)}
        onKeyDown={({ key }) => {
          if (key === 'Enter') callback(val)
          if (key === 'ArrowUp') callback(val)
          if (key === 'ArrowDown') callback(val)
        }}
        {...inputFields}
      />
    </Option>
  )
}

//
// ─── TOGGLE OPTION ──────────────────────────────────────────────────────────────
//

export type ToggleOptionProps = {
  label: string
  keyCode?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

export const ToggleOption = ({ label, keyCode, checked, disabled, onChange }: ToggleOptionProps) => {
  const callback = () => {
    onChange(!checked)
  }

  return (
    <Option label={label} keyCode={keyCode} onClickLabel={callback}>
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={callback}
      />
    </Option>
  )
}

//
// ─── SELECT OPTION ──────────────────────────────────────────────────────────────
//

export type SelectOptionChoice<T extends string = string> = { label: string; value: T }

export type SelectOptionProps<T extends string = string> = {
  label: string
  keyCode?: string
  value: T
  options: SelectOptionChoice<T>[]
  onChange: (value: T) => void
}

/** A button group in the style of the Material option; the button whose value matches is highlighted. */
export const SelectOption = <T extends string = string>({
  label,
  keyCode,
  value,
  options,
  onChange,
}: SelectOptionProps<T>) => (
  <Option label={label} keyCode={keyCode} leftClass="shrink-0 pr-2">
    <div className="flex flex-wrap justify-end gap-1">
      {options.map(option => (
        <button
          key={`select-option-${label}-${option.value}`}
          className={cn(
            'rounded-xl border px-2 text-sm',
            value === option.value && 'border-[#3273f6] bg-[#3273f6]'
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  </Option>
)
