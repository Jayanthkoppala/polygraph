import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-2 font-mono text-sm text-[#EDEDED] shadow-xs transition-[color,box-shadow] outline-none placeholder:text-[#8B949E] focus-visible:border-[#EDEDED] focus-visible:ring-[3px] focus-visible:ring-[#EDEDED]/50 disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-[var(--color-verdict-shape)] aria-invalid:ring-[var(--color-verdict-shape)]/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
