---
name: Memory Chain
colors:
  surface: '#fbf9f6'
  surface-dim: '#dbdad7'
  surface-bright: '#fbf9f6'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3f0'
  surface-container: '#efeeeb'
  surface-container-high: '#eae8e5'
  surface-container-highest: '#e4e2df'
  on-surface: '#1b1c1a'
  on-surface-variant: '#53433e'
  inverse-surface: '#30312f'
  inverse-on-surface: '#f2f0ed'
  outline: '#85736d'
  outline-variant: '#d8c2ba'
  surface-tint: '#8a4f36'
  primary: '#8a4f36'
  on-primary: '#ffffff'
  primary-container: '#d48c6f'
  on-primary-container: '#582711'
  inverse-primary: '#ffb598'
  secondary: '#665d56'
  on-secondary: '#ffffff'
  secondary-container: '#ebddd5'
  on-secondary-container: '#6a615b'
  tertiary: '#645d55'
  on-tertiary: '#ffffff'
  tertiary-container: '#a49c92'
  on-tertiary-container: '#39342d'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdbce'
  primary-fixed-dim: '#ffb598'
  on-primary-fixed: '#370e00'
  on-primary-fixed-variant: '#6e3821'
  secondary-fixed: '#ede0d8'
  secondary-fixed-dim: '#d1c4bc'
  on-secondary-fixed: '#211a16'
  on-secondary-fixed-variant: '#4e453f'
  tertiary-fixed: '#ebe1d6'
  tertiary-fixed-dim: '#cec5ba'
  on-tertiary-fixed: '#1f1b14'
  on-tertiary-fixed-variant: '#4c463e'
  background: '#fbf9f6'
  on-background: '#1b1c1a'
  surface-variant: '#e4e2df'
typography:
  display-lg:
    fontFamily: Libre Caslon Text
    fontSize: 48px
    fontWeight: '400'
    lineHeight: 56px
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: Libre Caslon Text
    fontSize: 36px
    fontWeight: '400'
    lineHeight: 44px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Libre Caslon Text
    fontSize: 32px
    fontWeight: '400'
    lineHeight: 40px
  headline-sm:
    fontFamily: Libre Caslon Text
    fontSize: 24px
    fontWeight: '400'
    lineHeight: 32px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  container-max: 1200px
  gutter: 24px
  margin-desktop: 64px
  margin-mobile: 24px
  stack-sm: 8px
  stack-md: 24px
  stack-lg: 48px
---

## Brand & Style
The design system is anchored in the concept of "Eternal Compassion." It serves users during moments of profound loss, requiring a UI that feels like a quiet, respectful sanctuary. The target audience includes pet owners seeking a permanent, decentralized way to honor their companions.

The aesthetic direction is **Refined Minimalism with Tactile Warmth**. It avoids the coldness often associated with blockchain technology, instead opting for a sophisticated, editorial feel. The UI leverages generous whitespace to provide "breathing room" for emotional processing, ensuring that the focus remains on the memories and the permanence of the record. The style is professional and grounded, yet deeply empathetic.

## Colors
The palette is inspired by natural materials—stone, earth, and parchment—to evoke a sense of timelessness.

- **Primary (#D48C6F):** A gentle terracotta used for primary calls to action, active states, and meaningful highlights. It represents the "warmth" of the memory.
- **Secondary (#2C2520):** A soft charcoal used for maximum legibility in typography. It is never pure black, ensuring the contrast remains accessible but soft on the eyes.
- **Neutral (#FAF8F5):** The warm beige foundation of the entire system. This color should be used for the global background to minimize eye strain and create a comforting environment.
- **Surface (#E8DED3):** A slightly darker beige used for card backgrounds and subtle UI layering to distinguish content from the global canvas.

## Typography
This design system utilizes a high-contrast typographic pairing to balance tradition with modernity.

- **Headlines (Libre Caslon Text):** Chosen for its literary, historical elegance. It conveys the "Eternal" aspect of the brand. Use for page titles, section headers, and poetic excerpts.
- **Body & Labels (Plus Jakarta Sans):** A modern, soft sans-serif that provides clarity and a welcoming tone for functional information.
- **Hierarchy:** Maintain a clear distinction between editorial content (Serif) and functional UI (Sans-serif). Display sizes should utilize slight negative letter-spacing for a more polished, premium feel.

## Layout & Spacing
The layout follows a **Fluid Grid** model with a fixed maximum width for readability.

- **Structure:** A 12-column grid is used for desktop, 6-column for tablet, and 2-column for mobile.
- **Rhythm:** An 8px base unit drives all spacing decisions. Consistent vertical stacks (`stack-md` for related elements, `stack-lg` for section breaks) ensure a predictable and calm scanning experience.
- **Margins:** Generous outer margins (64px on desktop) are critical to maintain the "Minimalist" brand pillar. On mobile, these shrink to 24px to maximize screen real estate while preserving the sense of openness.

## Elevation & Depth
This design system avoids heavy shadows, favoring a **Tonal Layering** and **Minimalist Outline** approach.

- **Planes:** Hierarchy is established through subtle shifts in background color (e.g., a card using a #E8DED3 surface on a #FAF8F5 background).
- **Outlines:** Use thin, low-contrast borders (1px, 15% opacity of the Secondary color) to define interactive areas like input fields and card boundaries.
- **Interactions:** A very soft, highly diffused ambient shadow (10% opacity) may be applied only to floating elements like modals or dropdowns to signify they are on a superior Z-index.

## Shapes
The shape language is consistently **Rounded**, reflecting the "Compassionate" personality. 

- **Primary Radius:** 16px (`rounded-lg`) is the standard for cards, large buttons, and image containers.
- **Small Elements:** 8px (`rounded-md`) for smaller components like chips or input fields.
- **Visual Style:** Lines are kept thin and clean. Interactive elements should feel soft to the touch, avoiding any sharp corners that might feel aggressive or clinical.

## Components
- **Buttons:** Primary buttons use the Terracotta background with White or light beige text. They feature 16px corners and generous internal padding (16px 32px). Secondary buttons use a minimalist outline of the Secondary color.
- **Cards:** Cards are the primary container for memorial entries. They should use the Surface color (#E8DED3) with a 1px soft border and 16px corner radius. No heavy shadows.
- **Input Fields:** Minimalist design with a subtle bottom-border or light outline. Use Plus Jakarta Sans for input text. Labels should be small and uppercase.
- **Chips/Tags:** Used for "Memorial Categories" (e.g., Canine, Feline, Equine). Rounded-full (pill-shaped) with a light version of the primary color background.
- **Lists:** Clean, spacious lists with dividers that don't reach the full width of the container, creating a lighter, more modern feel.
- **Memorial Timeline:** A specific component using a thin vertical line in Terracotta to connect chronological "Life Events" in a pet's history.