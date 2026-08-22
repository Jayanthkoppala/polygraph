import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { motion, type MotionProps } from 'motion/react';
import './magicui.css';

type ShinyButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof MotionProps> & MotionProps & {
  children: ReactNode;
  className?: string;
};

const animationProps: MotionProps = {
  initial: { '--x': '100%', scale: 0.92 },
  animate: { '--x': '-100%', scale: 1 },
  whileTap: { scale: 0.96 },
  transition: {
    repeat: Infinity,
    repeatType: 'loop',
    repeatDelay: 1,
    type: 'spring',
    stiffness: 20,
    damping: 15,
    mass: 2,
    scale: { type: 'spring', stiffness: 200, damping: 7, mass: 0.5 },
  },
};

/** Adapted from Magic UI's official Shiny Button registry component. */
export const ShinyButton = forwardRef<HTMLButtonElement, ShinyButtonProps>(({ children, className = '', ...props }, ref) => (
  <motion.button ref={ref} className={`pg-magic-shiny-button ${className}`.trim()} {...animationProps} {...props}>
    <span className="pg-magic-shiny-button__label">{children}</span>
    <span className="pg-magic-shiny-button__shine" aria-hidden="true" />
  </motion.button>
));

ShinyButton.displayName = 'ShinyButton';
