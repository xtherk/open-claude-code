#include <ApplicationServices/ApplicationServices.h>
#include <node_api.h>

#include <array>
#include <cstring>

namespace {

struct ModifierEntry {
  const char* name;
  const char* alias;
  CGEventFlags mask;
};

constexpr std::array<ModifierEntry, 4> kModifiers = {{
    {"shift", nullptr, kCGEventFlagMaskShift},
    {"command", "cmd", kCGEventFlagMaskCommand},
    {"control", "ctrl", kCGEventFlagMaskControl},
    {"option", "alt", kCGEventFlagMaskAlternate},
}};

CGEventFlags GetCurrentFlags() {
  return CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
}

const ModifierEntry* FindModifier(const char* value) {
  for (const ModifierEntry& entry : kModifiers) {
    if (std::strcmp(value, entry.name) == 0) {
      return &entry;
    }
    if (entry.alias != nullptr && std::strcmp(value, entry.alias) == 0) {
      return &entry;
    }
  }
  return nullptr;
}

bool ReadUtf8Argument(napi_env env, napi_value value, char* buffer, size_t length) {
  size_t copied = 0;
  napi_status status = napi_get_value_string_utf8(env, value, buffer, length, &copied);
  if (status != napi_ok) {
    napi_throw_type_error(env, nullptr, "modifier must be a string");
    return false;
  }

  if (copied >= length) {
    buffer[length - 1] = '\0';
  }
  return true;
}

napi_value CreateBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value CreateUndefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value GetModifiers(napi_env env, napi_callback_info info) {
  (void)info;

  napi_value array;
  napi_create_array_with_length(env, kModifiers.size(), &array);

  const CGEventFlags flags = GetCurrentFlags();
  uint32_t writeIndex = 0;

  for (const ModifierEntry& entry : kModifiers) {
    if ((flags & entry.mask) == 0) {
      continue;
    }

    napi_value name;
    napi_create_string_utf8(env, entry.name, NAPI_AUTO_LENGTH, &name);
    napi_set_element(env, array, writeIndex, name);
    writeIndex += 1;
  }

  return array;
}

napi_value IsModifierPressed(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_status status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (status != napi_ok || argc < 1) {
    napi_throw_type_error(env, nullptr, "isModifierPressed(modifier) requires one string argument");
    return nullptr;
  }

  char modifier[32] = {0};
  if (!ReadUtf8Argument(env, args[0], modifier, sizeof(modifier))) {
    return nullptr;
  }

  const ModifierEntry* entry = FindModifier(modifier);
  if (entry == nullptr) {
    return CreateBoolean(env, false);
  }

  const CGEventFlags flags = GetCurrentFlags();
  return CreateBoolean(env, (flags & entry->mask) != 0);
}

napi_value Prewarm(napi_env env, napi_callback_info info) {
  (void)info;
  (void)GetCurrentFlags();
  return CreateUndefined(env);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {"getModifiers", nullptr, GetModifiers, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isModifierPressed", nullptr, IsModifierPressed, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"prewarm", nullptr, Prewarm, nullptr, nullptr, nullptr, napi_default, nullptr},
  };

  napi_define_properties(
      env,
      exports,
      sizeof(descriptors) / sizeof(descriptors[0]),
      descriptors);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
