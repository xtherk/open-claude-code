{
  'targets': [
    {
      'target_name': 'modifiers',
      'conditions': [
        ['OS=="mac"', {
          'sources': ['src/modifiers.mm'],
          'xcode_settings': {
            'CLANG_ENABLE_OBJC_ARC': 'YES',
            'OTHER_LDFLAGS': [
              '-framework',
              'ApplicationServices',
            ],
          },
        }, {
          'sources': ['src/unsupported.cc'],
        }],
      ],
    },
  ],
}
