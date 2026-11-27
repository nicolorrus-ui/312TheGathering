// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package forgehost

// RuntimeID covers native sources, reviewed patches, and the diagnostic generator.
// Verify changes with third_party/forge-runtime/build-overlay.py --identity.
const RuntimeID = "230914a40a9e1e767391c3be990a349015b35761-adapter43-4e2bb7c6df6cba732f07049209e325016d6457aa4c9d5640dfbe74c4752b31b2"

// BaseRuntimeID is the immutable downloadable resource/dependency distribution.
// The packaged overlay supersedes its old adapter classes before starting Java.
const BaseRuntimeID = "230914a40a9e1e767391c3be990a349015b35761-adapter43-4e2bb7c6df6cba732f07049209e325016d6457aa4c9d5640dfbe74c4752b31b2"
