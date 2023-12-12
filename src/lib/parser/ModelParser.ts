import {
  GetAccessorDeclaration,
  MethodDeclaration,
  MethodSignature,
  PropertyDeclaration,
  PropertySignature,
  SetAccessorDeclaration,
  TypeReferenceNode,
  ts,
} from "ts-morph";
import { ParsedClass, ParsedInterface, ParsedTypeAlias, Parser } from "./Parser";

type DefaultSchemaField = { name: string; type: Model | string };
type ArraySchemaField = { name: string; type: "array"; elementType: Model | (string & {}) };
type ReferenceSchemaField = {
  name: string;
  type: "reference";
  referenceName: string;
  arguments: (Model | (string & {}))[];
};
type FunctionSchemaField = {
  name: string;
  type: "function";
  arguments: { name: string; type: Model | string }[];
  returnType: Model | [Model | (string & {})] | (string & {});
};
type SchemaField = ArraySchemaField | DefaultSchemaField | FunctionSchemaField | ReferenceSchemaField;
type Prop =
  | GetAccessorDeclaration
  | MethodDeclaration
  | MethodSignature
  | PropertyDeclaration
  | PropertySignature
  | SetAccessorDeclaration;

export const isArraySchemaField = (field: SchemaField): field is ArraySchemaField => {
  return field.type === "array";
};
export const isReferenceSchemaField = (field: SchemaField): field is ReferenceSchemaField => {
  return field.type === "reference";
};
export const isFunctionSchemaField = (field: SchemaField): field is FunctionSchemaField => {
  return field.type === "function";
};
export const isDefaultSchemaField = (field: SchemaField): field is DefaultSchemaField => {
  return !isArraySchemaField(field) && !isReferenceSchemaField(field);
};

type ModelBase = {
  id: string;
  name: string;
  schema: SchemaField[];
  dependencies: Model[];
  dependants: Model[];
  arguments: { name: string; extends?: string }[];
};

type InterfaceModel = ModelBase & {
  type: "interface";
  extends: (Model | (string & {}))[];
};
type TypeAliasModel = ModelBase & {
  type: "typeAlias";
};
type ClassModel = ModelBase & {
  type: "class";
  extends?: Model | string;
  implements: (Model | (string & {}))[];
};

export type Model = ClassModel | InterfaceModel | TypeAliasModel;

const trimImport = (str: string) => str.replace(`import("/source").`, "");

export class ModelParser extends Parser {
  // eslint-disable-next-line sonarjs/cognitive-complexity
  getModels() {
    const models: Model[] = [];
    const modelNameToModelMap = new Map<string, Model>();
    const dependencyMap = new Map<string, Set<Model>>();

    // first pass: build nodes and models
    const items: ({ id: string; name: string; compilerType: ts.Type } & (
      | { type: "class"; model: ClassModel; node: ParsedClass }
      | { type: "interface"; model: InterfaceModel; node: ParsedInterface }
      | { type: "typeAlias"; model: TypeAliasModel; node: ParsedTypeAlias }
    ))[] = [];

    for (const _interface of this.interfaces) {
      const name = _interface.name;
      const compilerType = _interface.declaration.getType().compilerType;

      const model: InterfaceModel = {
        id: name,
        name,
        extends: [],
        schema: [],
        dependencies: [],
        dependants: [],
        type: "interface",
        arguments: [],
      };

      for (const parameter of _interface.declaration.getTypeParameters()) {
        const parameterName = parameter.getName();
        const parameterType = parameter.getType();
        const parameterExtends = parameterType.getConstraint()?.getText();
        model.arguments.push({ name: parameterName, extends: parameterExtends });
      }

      for (const extendsExpression of _interface.extends) {
        const extendsName = trimImport(extendsExpression.getText());
        const extendsModel = modelNameToModelMap.get(extendsName);
        if (extendsModel) {
          model.extends.push(extendsModel);
        } else model.extends.push(extendsName);
      }

      models.push(model);

      modelNameToModelMap.set(model.id, model);
      items.push({
        type: "interface",
        id: name,
        name,
        node: _interface,
        compilerType,
        model,
      });
    }

    for (const typeAlias of this.typeAliases) {
      const name = typeAlias.name;
      const type = typeAlias.declaration.getType().compilerType;

      const model: TypeAliasModel = {
        id: name,
        name,
        schema: [],
        dependencies: [],
        dependants: [],
        type: "typeAlias",
        arguments: [],
      };

      for (const parameter of typeAlias.declaration.getTypeParameters()) {
        const parameterName = parameter.getName();
        const parameterType = parameter.getType();
        const parameterExtends = parameterType.getConstraint()?.getText();
        model.arguments.push({ name: parameterName, extends: parameterExtends });
      }

      models.push(model);
      modelNameToModelMap.set(model.id, model);

      items.push({
        type: "typeAlias",
        id: name,
        name,
        node: typeAlias,
        compilerType: type,
        model,
      });
    }

    for (const currentClass of this.classes) {
      const name = currentClass.name;
      const type = currentClass.declaration.getType().compilerType;

      const model: ClassModel = {
        id: name,
        name,
        implements: [],
        schema: [],
        dependencies: [],
        dependants: [],
        type: "class",
        arguments: [],
      };

      for (const parameter of currentClass.declaration.getTypeParameters()) {
        const parameterName = parameter.getName();
        const parameterType = parameter.getType();
        const parameterExtends = parameterType.getConstraint()?.getText();
        model.arguments.push({ name: parameterName, extends: parameterExtends });
      }

      if (currentClass.extends) {
        const extendsName = trimImport(currentClass.extends.getText());
        const extendsModel = modelNameToModelMap.get(extendsName);
        if (extendsModel) {
          model.extends = extendsModel;
        } else model.extends = extendsName;
      }

      if (currentClass.implements.length > 0) {
        for (const implementsExpression of currentClass.implements) {
          const implementsName = trimImport(implementsExpression.getText());
          const implementsModel = modelNameToModelMap.get(implementsName);
          model.implements.push(implementsModel ?? implementsName);
        }
      }

      models.push(model);
      modelNameToModelMap.set(model.id, model);

      items.push({
        type: "class",
        id: name,
        name,
        node: currentClass,
        compilerType: type,
        model,
      });
    }

    // second pass: parse schema and root dependencies
    for (const item of items) {
      const model = modelNameToModelMap.get(item.name);
      if (!model) continue;

      const dependencies = dependencyMap.get(item.name) ?? new Set<Model>();

      // helpers
      const addFunctionProp = (prop: Prop) => {
        const name = prop.getName();
        const callSignatures = prop.getType().getCallSignatures();

        if (callSignatures.length === 1) {
          const callSignature = callSignatures[0];
          const functionArguments: { name: string; type: Model | string }[] = [];

          for (const parameter of callSignature.getParameters()) {
            const parameterName = parameter.getName();
            const parameterTypeName = trimImport(parameter.getTypeAtLocation(prop).getText());
            const parameterTypeModel = modelNameToModelMap.get(parameterTypeName);
            if (parameterTypeModel) dependencies.add(parameterTypeModel);
            functionArguments.push({
              name: parameterName,
              type: parameterTypeModel ?? parameterTypeName,
            });
          }

          const returnType = callSignature.getReturnType();
          const isArray = returnType.isArray();
          const returnTypeName = isArray
            ? trimImport(returnType.getArrayElementType()?.getText() ?? "")
            : trimImport(returnType.getText());
          const returnTypeModel = modelNameToModelMap.get(returnTypeName);
          if (returnTypeModel) dependencies.add(returnTypeModel);

          model.schema.push({
            name,
            type: "function",
            arguments: functionArguments,
            returnType: isArray ? [returnTypeModel ?? returnTypeName] : returnTypeModel ?? returnTypeName,
          });
          return true;
        }

        return false;
      };

      const addArrayProp = (prop: Prop) => {
        if (!prop.getType().isArray()) return false;

        const name = prop.getName();

        const elementType = prop.getType().getArrayElementType();
        if (!elementType) return false;
        const elementTypeName = trimImport(elementType.getText());
        const elementTypeModel = modelNameToModelMap.get(elementTypeName);

        model.schema.push({
          name,
          type: "array",
          elementType: elementTypeModel ?? elementTypeName,
        });
        if (elementTypeModel) dependencies.add(elementTypeModel);

        return true;
      };

      const addGenericProp = (prop: Prop) => {
        const name = prop.getName();

        const aliasSymbol = prop.getType().getAliasSymbol();
        const symbol = aliasSymbol ?? prop.getType().getSymbol();
        const typeArguments = aliasSymbol
          ? prop.getType().getAliasTypeArguments()
          : prop.getType().getTypeArguments();
        const typeNode =
          "getTypeNode" in prop ? (prop.getTypeNode() as TypeReferenceNode | undefined) : undefined;
        const typeNodeArguments = typeNode?.isKind(ts.SyntaxKind.TypeReference)
          ? typeNode.getTypeArguments()
          : [];

        if (symbol && typeArguments.length > 0) {
          const genericName = symbol.getName();
          if (!genericName) return false;

          const genericModel = modelNameToModelMap.get(genericName);
          if (genericModel) dependencies.add(genericModel);

          const schemaField: ReferenceSchemaField = {
            name,
            type: "reference",
            referenceName: genericName,
            arguments: [],
          };

          for (const [i, typeArgument] of typeArguments.entries()) {
            let typeArgumentName = trimImport(typeArgument.getText());
            if (typeNodeArguments[i] && typeNodeArguments[i].isKind(ts.SyntaxKind.TypeReference)) {
              typeArgumentName = trimImport(typeNodeArguments[i].getText());
            }

            const typeArgumentModel = modelNameToModelMap.get(typeArgumentName);

            schemaField.arguments.push(typeArgumentModel ?? typeArgumentName);
            if (typeArgumentModel) dependencies.add(typeArgumentModel);
          }

          model.schema.push(schemaField);
          return true;
        }

        return false;
      };

      const addDefaultProp = (prop: Prop) => {
        const name = prop.getName();
        let typeName = trimImport(prop.getType().getText());

        const symbolDeclaration = prop.getSymbol()?.getDeclarations()[0];
        if (symbolDeclaration && symbolDeclaration.isKind(ts.SyntaxKind.PropertySignature)) {
          const declarationName = symbolDeclaration.getTypeNode()?.getText();
          if (declarationName) typeName = trimImport(declarationName);
        }

        const typeModel = modelNameToModelMap.get(typeName);
        if (typeModel) dependencies.add(typeModel);
        model.schema.push({
          name,
          type: typeModel ?? typeName,
        });
      };

      if (item.type === "typeAlias") {
        if (
          [
            //
            item.node.type.isNumber(),
            item.node.type.isString(),
            item.node.type.isBoolean(),
            item.node.type.isUndefined(),
            item.node.type.isNull(),
            item.node.type.isAny(),
            item.node.type.isUnknown(),
            item.node.type.isNever(),
            item.node.type.isEnum(),
            item.node.type.isEnumLiteral(),
            item.node.type.isLiteral(),
            item.node.type.isUnion(),
          ].some(Boolean)
        ) {
          model.schema.push({ name: "==>", type: item.node.type.getText() });
          continue;
        }

        for (const prop of item.node.type.getProperties()) {
          const valueDeclaration = prop.getValueDeclaration() as PropertySignature;
          if (addFunctionProp(valueDeclaration)) continue;
          if (addArrayProp(valueDeclaration)) continue;
          if (addGenericProp(valueDeclaration)) continue;
          addDefaultProp(valueDeclaration);
        }
      }

      if (item.type === "interface") {
        for (const extended of item.node.extends) {
          const extendsName = trimImport(extended.getText());
          const extendsModel = modelNameToModelMap.get(extendsName);
          if (extendsModel) dependencies.add(extendsModel);
        }

        for (const prop of [
          ...item.node.properties,
          ...item.node.methods,
          ...item.node.declaration.getGetAccessors(),
          ...item.node.declaration.getSetAccessors(),
        ]) {
          if (addFunctionProp(prop)) continue;
          if (addArrayProp(prop)) continue;
          if (addGenericProp(prop)) continue;
          addDefaultProp(prop);
        }
      }

      if (item.type === "class") {
        if (item.node.extends) {
          const extendsName = trimImport(item.node.extends.getText());
          const extendsModel = modelNameToModelMap.get(extendsName);
          if (extendsModel) dependencies.add(extendsModel);
        }

        for (const implemented of item.node.implements) {
          const implementsName = trimImport(implemented.getText());
          const implementsModel = modelNameToModelMap.get(implementsName);
          if (implementsModel) dependencies.add(implementsModel);
        }

        for (const prop of [
          ...item.node.properties,
          ...item.node.methods,
          ...item.node.declaration.getGetAccessors(),
          ...item.node.declaration.getSetAccessors(),
        ]) {
          if (addFunctionProp(prop)) continue;
          if (addArrayProp(prop)) continue;
          if (addGenericProp(prop)) continue;
          addDefaultProp(prop);
        }
      }

      dependencyMap.set(item.name, dependencies);
    }

    // third pass: link dependencies
    for (const [name, dependencies] of dependencyMap.entries()) {
      const model = modelNameToModelMap.get(name);
      if (!model) continue;

      for (const dependency of dependencies) {
        model.dependencies.push(dependency);
        dependency.dependants.push(model);
      }
    }

    return models;
  }
}
