import * as React from "react"
import { Check as CheckIcon } from "@phosphor-icons/react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-[var(--color-line)] bg-[var(--color-sunken)] shadow-xs transition-shadow outline-none focus-visible:border-[#EDEDED] focus-visible:ring-[3px] focus-visible:ring-[#EDEDED]/50 disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-[var(--color-verdict-shape)] aria-invalid:ring-[var(--color-verdict-shape)]/20 data-[state=checked]:border-[#EDEDED] data-[state=checked]:bg-[#EDEDED] data-[state=checked]:text-[#131209]",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" weight="bold" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
