---
name: Xgoat.Cast 屏幕共享
description: 网页端与 Windows 客户端统一的橙白界面
colors:
  primary: "#FF6014"
  primary-text: "#A94004"
  primary-hover: "#F37130"
  primary-focus: "#BD4C0D"
  primary-border: "#EC570F"
  primary-shadow-soft: "rgba(104,53,20,.13)"
  primary-shadow: "rgba(104,53,20,.14)"
  primary-shadow-hover: "rgba(104,53,20,.18)"
  button-ink: "#381C0D"
  neutral-bg: "#F2F2F0"
  neutral-top: "#F8F8F6"
  surface: "#FFFEFD"
  text: "#20211F"
  muted: "#5B5E59"
  border: "#D9DDD6"
  border-input: "#CBD0C7"
  surface-muted: "#E8EBE5"
  placeholder: "#6B6E68"
  footer-muted: "#767A73"
  selection: "#FFD6C3"
  scrollbar: "#C3C8BF"
  scrollbar-hover: "#AAB1A5"
  state-danger: "#A0342D"
  state-warning: "#895216"
  state-success: "#30694B"
  state-info: "#365B82"
  video: "#232728"
typography:
  display:
    fontFamily: "Microsoft YaHei UI, Segoe UI, Noto Sans CJK SC, system-ui, sans-serif"
    fontWeight: 550
    lineHeight: 1.14
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Microsoft YaHei UI, Segoe UI, Noto Sans CJK SC, system-ui, sans-serif"
    fontWeight: 300
    lineHeight: 1.6
  label:
    fontFamily: "Microsoft YaHei UI, Segoe UI, Noto Sans CJK SC, system-ui, sans-serif"
    fontWeight: 450
rounded:
  xs: "4px"
  sm: "6px"
  md: "12px"
  lg: "16px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "14px 24px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "24px"
---

## Overview

The web pages use the same warm gray-white surfaces, vivid orange action color, thin system typography, and compact controls as the Xgoat.Cast Windows client. A restrained inset highlight and short downward shadow give controls a slight physical feel while the layout remains flat. The user's own panel name leads the self-hosted homepage. The product name is “Xgoat.Cast 屏幕共享” where the platform is speaking.

## Colors

Use orange for the primary action and selected states. Use dark orange for small text on light surfaces. Keep page backgrounds warm gray, cards near white, and dividers muted gray. Video areas alone use the dark `video` tone with white controls.

## Typography

Use the local YaHei UI / Segoe UI stack. Body copy is light; headings are moderate rather than heavy. Keep Chinese labels readable at 14px or larger for primary form controls. Reserve 12px for supporting notes and attribution.

## Layout

The marketing homepage uses a wide two-column opening with an illustrative HTML preview of the self-hosted webpage. Management pages use a side navigation on desktop and a horizontal navigation row on narrow screens. Sharing uses a large preview beside a narrower settings column, then stacks on mobile. Panel home centers the owner's title and places the start action above ongoing shares.

## Elevation & Depth

Most surfaces use a one-pixel border and a very short inset highlight or downward shadow. The homepage preview can carry a slightly deeper soft shadow. The video stage is distinct through its dark fill.

## Shapes

Buttons, selects and text inputs use 6px corners on every page, including management. Cards use 12–16px corners. Circular icon buttons and pill switches retain their functional shape. Avoid glass effects.

## Components

The primary button is solid orange with dark text. Secondary buttons are near white with gray borders. Settings are grouped into outlined cards. Long option lists use native selects. Toggles show their state in text as well as color. Copy actions have explicit feedback.

## Do's and Don'ts

- Say “共享人” in share and panel flows; never invent a room name.
- Keep self-hosted pages owner branded, with Xgoat and Agora support in quiet footer text.
- Show the microphone only on self-hosted browser sharing, initially off.
- Keep the homepage preview representative of a self-hosted webpage, with illustrative content labeled as such.
- Avoid dark purple themes, gradient text, large blurred glass panels, and loud support branding.
