import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Toggle as TogglePrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none text-[#9B9B9B] hover:bg-[var(--color-raised)] hover:text-[#EDEDED] focus-visible:border-[#EDEDED] focus-visible:ring-[3px] focus-visible:ring-[#EDEDED]/50 disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-[var(--color-verdict-shape)] aria-invalid:ring-[var(--color-verdict-shape)]/20 data-[state=on]:bg-[var(--color-raised)] data-[state=on]:text-[#EDEDED] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-[var(--color-line)] bg-transparent shadow-xs hover:bg-[var(--color-raised)] hover:text-[#EDEDED]",
      },
      size: {
        default: "h-9 min-w-9 px-2",
        sm: "h-8 min-w-8 px-1.5",
        lg: "h-10 min-w-10 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
