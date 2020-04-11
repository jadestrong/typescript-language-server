module.exports = {
    "env": {
        "browser": true,
        "node": true
    },
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
        "project": "tsconfig.json",
        "sourceType": "module"
    },
    "plugins": [
        "@typescript-eslint/eslint-plugin",
    ],
    "rules": {
        "@typescript-eslint/class-name-casing": "error",
        "@typescript-eslint/indent": "error",
        "@typescript-eslint/type-annotation-spacing": "error",
        "camelcase": "off",
        "comma-dangle": "off",
        "curly": "error",
        "eqeqeq": [
            "error",
            "smart"
        ],
        "guard-for-in": "error",
        "id-blacklist": "off",
        "id-match": "off",
        "max-len": [
            "error",
            {
                "code": 180
            }
        ],
        "no-trailing-spaces": "error",
        "no-underscore-dangle": "off",
        "no-var": "error",
        "radix": "error",
        "spaced-comment": "error",
        "@typescript-eslint/tslint/config": [
            "error",
            {
                "rules": {
                    "one-line": [
                        true,
                        "check-open-brace",
                        "check-catch",
                        "check-else",
                        "check-whitespace"
                    ],
                    "whitespace": [
                        true,
                        "check-branch",
                        "check-decl",
                        "check-operator",
                        "check-separator",
                        "check-type"
                    ]
                }
            }
        ]
    }
};
