'use client'

import { MODEL_CONNECTION_CHOICES, type ModelConnectionKind } from '../../core/v4/product/modelConnection'

export function ModelConnectionChoices({ selected, disabled, onSelect }: {
  selected?: ModelConnectionKind | null
  disabled?: boolean
  onSelect: (kind: ModelConnectionKind) => void
}) {
  return <div className="model-connection-choices" role="group" aria-label="How to connect your model">
    {MODEL_CONNECTION_CHOICES.map((choice) => <button type="button" key={choice.id}
      aria-pressed={selected === choice.id} disabled={disabled} onClick={() => onSelect(choice.id)}>
      <strong>{choice.title}</strong><span>{choice.detail}</span>
    </button>)}
  </div>
}
