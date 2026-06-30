import { useState, useEffect } from 'react'

// Renders an addon's bundled logo (logo_url) and falls back to its emoji icon
// if the addon has no logo or the image fails to load.
export default function AddonIcon({ addon, imgClassName, iconClassName }) {
  const [failed, setFailed] = useState(false)

  // Reset the error state when the addon (and thus its logo URL) changes.
  useEffect(() => { setFailed(false) }, [addon?.logo_url])

  if (addon?.logo_url && !failed) {
    return (
      <img
        src={addon.logo_url}
        alt=""
        className={imgClassName}
        onError={() => setFailed(true)}
      />
    )
  }
  return <span className={iconClassName}>{addon?.icon}</span>
}
