#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/ios/App"
CONFIGURATION="${CONFIGURATION:-Release}"
SCHEME="${SCHEME:-App}"
PROJECT="${PROJECT:-${IOS_DIR}/App.xcodeproj}"
DERIVED_DATA="${DERIVED_DATA:-${IOS_DIR}/build}"
IPA_NAME="${IPA_NAME:-ListenPage.ipa}"
ADHOC_SIGN="${ADHOC_SIGN:-1}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "IPA builds require macOS with Xcode; current OS is $(uname -s)"
for cmd in xcodebuild codesign ditto unzip /usr/libexec/PlistBuddy; do
  command -v "${cmd}" >/dev/null 2>&1 || fail "missing required tool: ${cmd}"
done
[[ -d "${PROJECT}" ]] || fail "Xcode project not found: ${PROJECT}"

cd "${IOS_DIR}"

xcodebuild \
  -project "${PROJECT}" \
  -scheme "${SCHEME}" \
  -configuration "${CONFIGURATION}" \
  -resolvePackageDependencies

xcodebuild \
  -project "${PROJECT}" \
  -scheme "${SCHEME}" \
  -configuration "${CONFIGURATION}" \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "${DERIVED_DATA}" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  ONLY_ACTIVE_ARCH=NO \
  build

PRODUCTS_DIR="${DERIVED_DATA}/Build/Products/${CONFIGURATION}-iphoneos"
[[ -d "${PRODUCTS_DIR}" ]] || fail "build products directory not found: ${PRODUCTS_DIR}"

shopt -s nullglob
APP_CANDIDATES=("${PRODUCTS_DIR}"/*.app)
shopt -u nullglob
[[ "${#APP_CANDIDATES[@]}" -eq 1 ]] || fail "expected exactly one .app in ${PRODUCTS_DIR}, found ${#APP_CANDIDATES[@]}"

APP_PATH="${APP_CANDIDATES[0]}"
APP_BASENAME="$(basename "${APP_PATH}")"
INFO_PLIST="${APP_PATH}/Info.plist"
[[ -f "${INFO_PLIST}" ]] || fail "missing Info.plist in ${APP_PATH}"
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${INFO_PLIST}")"
[[ -n "${EXECUTABLE_NAME}" && -f "${APP_PATH}/${EXECUTABLE_NAME}" ]] || fail "missing executable ${EXECUTABLE_NAME} in ${APP_PATH}"

STAGE_DIR="${DERIVED_DATA}/ipa-stage"
DIST_DIR="${DERIVED_DATA}/dist"
VERIFY_DIR="${DERIVED_DATA}/ipa-verify"
rm -rf "${STAGE_DIR}" "${VERIFY_DIR}"
mkdir -p "${STAGE_DIR}/Payload" "${DIST_DIR}"

STAGED_APP="${STAGE_DIR}/Payload/${APP_BASENAME}"
ditto "${APP_PATH}" "${STAGED_APP}"

if [[ "${ADHOC_SIGN}" == "1" ]]; then
  SIGN_LIST="$(mktemp -t listenpage-ipa-sign.XXXXXX)"
  trap 'rm -f "${SIGN_LIST}"' EXIT
  find "${STAGED_APP}" \( -name '*.framework' -o -name '*.appex' -o -name '*.dylib' \) -print0 >"${SIGN_LIST}" || true
  while IFS= read -r -d '' item; do
    codesign --force --sign - "${item}"
  done <"${SIGN_LIST}"
  rm -f "${SIGN_LIST}"
  trap - EXIT
  codesign --force --sign - "${STAGED_APP}"
  codesign --verify --strict --verbose=2 "${STAGED_APP}"
  [[ -d "${STAGED_APP}/_CodeSignature" ]] || fail "ad-hoc signature missing in ${STAGED_APP}"
fi

IPA_PATH="${DIST_DIR}/${IPA_NAME}"
rm -f "${IPA_PATH}"
(
  cd "${STAGE_DIR}"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent Payload "${IPA_PATH}"
)

[[ -s "${IPA_PATH}" ]] || fail "IPA was not created: ${IPA_PATH}"
unzip -l "${IPA_PATH}" | grep -E 'Payload/.+\.app/Info\.plist' >/dev/null || fail "IPA is missing Payload/*.app/Info.plist"
if [[ "${ADHOC_SIGN}" == "1" ]]; then
  unzip -l "${IPA_PATH}" | grep -E 'Payload/.+\.app/_CodeSignature/' >/dev/null || fail "IPA is missing _CodeSignature"
fi
FILE_OUT="$(file -b "${IPA_PATH}")"
echo "file(1): ${FILE_OUT}"
echo "${FILE_OUT}" | grep -Ei 'iOS App Zip|Zip archive' >/dev/null || fail "unexpected IPA file type: ${FILE_OUT}"

mkdir -p "${VERIFY_DIR}"
unzip -q "${IPA_PATH}" -d "${VERIFY_DIR}"
[[ -f "${VERIFY_DIR}/Payload/${APP_BASENAME}/Info.plist" ]] || fail "verify extract missing Info.plist"
[[ -f "${VERIFY_DIR}/Payload/${APP_BASENAME}/${EXECUTABLE_NAME}" ]] || fail "verify extract missing executable"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "IPA_PATH=${IPA_PATH}" >>"${GITHUB_ENV}"
fi

echo "Packaged OK → ${IPA_PATH}"
