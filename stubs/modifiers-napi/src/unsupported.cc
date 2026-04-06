#include <node_api.h>

namespace {

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
  napi_create_array_with_length(env, 0, &array);
  return array;
}

napi_value IsModifierPressed(napi_env env, napi_callback_info info) {
  (void)info;
  return CreateBoolean(env, false);
}

napi_value Prewarm(napi_env env, napi_callback_info info) {
  (void)info;
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
